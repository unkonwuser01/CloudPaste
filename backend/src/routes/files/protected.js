import { ApiStatus, UserType } from "../../constants/index.js";
import {
  getAdminFileList,
  getAdminFileDetail,
  getUserFileList,
  getUserFileDetail,
  updateFile,
} from "../../services/fileService.js";
import { invalidateFsCache } from "../../cache/invalidation.js";
import { VfsNodesRepository, VFS_ROOT_PARENT_ID } from "../../repositories/VfsNodesRepository.js";
import { ShareRecordService } from "../../services/share/ShareRecordService.js";
import { useRepositories } from "../../utils/repositories.js";
import { ValidationError } from "../../http/errors.js";
import { getEncryptionSecret } from "../../utils/environmentUtils.js";
import { getPagination, jsonOk, jsonCreated } from "../../utils/common.js";
import { usePolicy } from "../../security/policies/policies.js";
import { resolvePrincipal } from "../../security/helpers/principal.js";

const requireFilesAccess = usePolicy("files.manage");

const getFilesPrincipal = (c) => resolvePrincipal(c, { allowedTypes: [UserType.ADMIN, UserType.API_KEY] });

export const registerFilesProtectedRoutes = (router) => {
  router.post("/api/files/import/telegram-manifest", requireFilesAccess, async (c) => {
    const db = c.env.DB;
    const encryptionSecret = getEncryptionSecret(c);
    const repositoryFactory = useRepositories(c);
    const { type: userType, userId, apiKeyInfo } = getFilesPrincipal(c);
    const body = await c.req.json();

    const storageConfigId = String(body.storage_config_id || body.storageConfigId || "").trim();
    const manifest = body.manifest;
    const filename = String(body.filename || "").trim();
    const directory = String(body.directory || body.dir || "/").trim() || "/";
    const mimeType = body.mime_type || body.mimeType || "application/octet-stream";
    const remark = body.remark || "";
    const slug = body.slug || undefined;
    const useProxy = typeof body.use_proxy === "boolean" ? body.use_proxy : (typeof body.useProxy === "boolean" ? body.useProxy : undefined);
    const password = body.password || null;
    const expiresInHoursRaw = body.expires_in_hours ?? body.expiresInHours ?? 0;
    const maxViewsRaw = body.max_views ?? body.maxViews ?? 0;

    if (!storageConfigId) throw new ValidationError("缺少 storage_config_id");
    if (!filename) throw new ValidationError("缺少 filename");
    if (!manifest || typeof manifest !== "object") throw new ValidationError("缺少 manifest");
    if (manifest.kind !== "telegram_manifest_v1") throw new ValidationError("manifest.kind 必须是 telegram_manifest_v1");
    if (!Array.isArray(manifest.parts) || manifest.parts.length === 0) throw new ValidationError("manifest.parts 不能为空");

    const normalizedManifest = {
      ...manifest,
      kind: "telegram_manifest_v1",
      target_chat_id: manifest.target_chat_id ?? manifest.targetChatId ?? null,
      parts: manifest.parts.map((part, index) => ({
        ...part,
        partNo: Number(part?.partNo ?? part?.part_no ?? part?.part ?? ((Number.isFinite(Number(part?.part_index)) ? Number(part?.part_index) : index) + 1)),
        size: Number(part?.size) || 0,
        file_id: part?.file_id ?? part?.fileId ?? null,
        file_unique_id: part?.file_unique_id ?? part?.fileUniqueId ?? null,
        message_id: part?.message_id ?? part?.messageId ?? part?.telegram_message_id ?? null,
        chat_id: part?.chat_id ?? part?.chatId ?? part?.target_chat_id ?? manifest.target_chat_id ?? manifest.targetChatId ?? null,
      })),
    };

    const storageConfigRepository = repositoryFactory.getStorageConfigRepository();
    const storageConfig = await storageConfigRepository.findById(storageConfigId);
    if (!storageConfig) throw new ValidationError("storage_config 不存在");
    if (String(storageConfig.storage_type) !== "TELEGRAM") throw new ValidationError("storage_config 不是 TELEGRAM 类型");

    const normalizedSize = Number(body.size ?? body.file_size ?? body.fileSize ?? manifest.parts.reduce((sum, part) => sum + (Number(part.size) || 0), 0));
    const size = Number.isFinite(normalizedSize) ? normalizedSize : 0;
    const expiresInHours = Number(expiresInHoursRaw) || 0;
    const maxViews = Number(maxViewsRaw) || 0;

    const ownerType = UserType.ADMIN;
    const ownerId = String(storageConfig.admin_id || userId || apiKeyInfo?.id || "").trim();
    if (!ownerId) throw new ValidationError("storage_config 缺少 admin_id，无法确定目录归属");

    const scopeType = "storage_config";
    const scopeId = String(storageConfig.id);
    const repo = new VfsNodesRepository(db, null);

    const mountRepository = repositoryFactory.getMountRepository();
    const mountRows = await mountRepository.findByStorageConfig(storageConfig.id, storageConfig.storage_type).catch(() => []);
    const mountRow = Array.isArray(mountRows) ? mountRows[0] : null;
    const mountPath = String(mountRow?.mount_path || "").trim();

    const safeDir = directory.startsWith("/") ? directory : `/${directory}`;
    let dirPath = safeDir === "/" ? "/" : safeDir.replace(/\/+$/u, "") || "/";
    if (mountPath && mountPath !== "/" && dirPath === mountPath) {
      dirPath = "/";
    } else if (mountPath && mountPath !== "/" && dirPath.startsWith(`${mountPath}/`)) {
      dirPath = dirPath.slice(mountPath.length) || "/";
    }

    const ensured = await repo.ensureDirectoryPath({ ownerType, ownerId, scopeType, scopeId, path: dirPath });
    const node = await repo.createOrUpdateFileNode({
      ownerType,
      ownerId,
      scopeType,
      scopeId,
      parentId: ensured?.parentId ?? VFS_ROOT_PARENT_ID,
      name: filename,
      mimeType,
      size,
      storageType: "TELEGRAM",
      contentRef: normalizedManifest,
    });

    const shareRecordService = new ShareRecordService(db, encryptionSecret, repositoryFactory);
    const shareRecord = await shareRecordService.createShareRecord({
      storageConfig,
      fsPath: null,
      storageSubPath: "",
      filename,
      size,
      remark,
      userIdOrInfo: userType === UserType.API_KEY ? (apiKeyInfo || userId) : userId,
      userType,
      slug,
      override: false,
      password,
      expiresInHours,
      maxViews,
      useProxy,
      mimeType,
      uploadResult: { storagePath: `vfs:${node.id}` },
      originalFilenameUsed: true,
      updateIfExists: true,
    });

    invalidateFsCache({ storageConfigId: storageConfig.id, reason: "telegram-manifest-import", db });

    return jsonCreated(c, {
      file: shareRecord,
      vfs_node: {
        id: node.id,
        name: node.name,
        parent_id: node.parent_id,
        storage_type: node.storage_type,
        size: node.size,
        mime_type: node.mime_type,
      },
      manifest: normalizedManifest,
    }, "Telegram manifest 导入成功");
  });
  router.get("/api/files", requireFilesAccess, async (c) => {
    const db = c.env.DB;
    const { type: userType, userId, apiKeyInfo } = getFilesPrincipal(c);

    let result;

    if (userType === UserType.ADMIN) {
      const { limit, offset } = getPagination(c, { limit: 30 });
      const search = c.req.query("search");
      const createdBy = c.req.query("created_by");

      const options = { limit, offset };
      if (search) options.search = search;
      if (createdBy) options.createdBy = createdBy;

      result = await getAdminFileList(db, options);
    } else {
      const { limit, offset } = getPagination(c, { limit: 30 });
      const search = c.req.query("search");

      const options = { limit, offset };
      if (search) options.search = search;

      result = await getUserFileList(db, userId, options);
    }

    const data = userType === UserType.API_KEY ? { ...result, key_info: apiKeyInfo } : result;
    return jsonOk(c, data, "获取文件列表成功");
  });

  router.get("/api/files/:id", requireFilesAccess, async (c) => {
    const db = c.env.DB;
    const { type: userType, userId } = getFilesPrincipal(c);
    const { id } = c.req.param();
    const encryptionSecret = getEncryptionSecret(c);
    const include = c.req.query("include");
    const linksFlag = c.req.query("links");
    const includeLinks = include === "links" || linksFlag === "true";
    const detailOptions = includeLinks ? { includeLinks: true } : {};

    let result;
    if (userType === UserType.ADMIN) {
      result = await getAdminFileDetail(db, id, encryptionSecret, c.req.raw, detailOptions);
    } else {
      result = await getUserFileDetail(db, id, userId, encryptionSecret, c.req.raw, detailOptions);
    }

    return jsonOk(c, result, "获取文件成功");
  });

  router.delete("/api/files/batch-delete", requireFilesAccess, async (c) => {
    const db = c.env.DB;
    const { type: userType, userId } = getFilesPrincipal(c);
    const body = await c.req.json();
    const ids = body.ids;
    const deleteMode = body.delete_mode || "both";

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      throw new ValidationError("请提供有效的文件ID数组");
    }

    if (!["record_only", "both"].includes(deleteMode)) {
      throw new ValidationError("删除模式必须是 'record_only' 或 'both'");
    }

    const result = { success: 0, failed: [] };
    const storageConfigIds = new Set();
    const encryptionSecret = getEncryptionSecret(c);
    const repositoryFactory = useRepositories(c);
    const fileRepository = repositoryFactory.getFileRepository();

    for (const id of ids) {
    await (async () => {
      let file;

      if (userType === UserType.ADMIN) {
        file = await fileRepository.findByIdWithStorageConfig(id);
        if (!file) {
          result.failed.push({ id, error: "文件不存在" });
          return;
        }
      } else {
        file = await fileRepository.findByIdAndCreator(id, `apikey:${userId}`);
        if (!file) {
          result.failed.push({ id, error: "文件不存在或无权删除" });
          return;
        }
      }

      if (file.storage_config_id) {
        storageConfigIds.add(file.storage_config_id);
      }

      await (async () => {
        if (deleteMode === "both" && file.file_path) {
          const { MountManager } = await import("../../storage/managers/MountManager.js");
          const { FileSystem } = await import("../../storage/fs/FileSystem.js");

          const mountManager = new MountManager(db, encryptionSecret, repositoryFactory, { env: c.env });
          const fileSystem = new FileSystem(mountManager);

          await fileSystem
            .batchRemoveItems([file.file_path], userType === UserType.ADMIN ? userId : `apikey:${userId}`, userType)
            .catch((fsError) => {
              console.error(`删除文件系统文件失败 (ID: ${id}):`, fsError);
            });
        }

        // storage-first 或无 file_path 时，直接按存储配置删除对象（通过 ObjectStore 统一封装）
        if (deleteMode === "both" && file.storage_path && file.storage_config_id) {
          try {
            const { ObjectStore } = await import("../../storage/object/ObjectStore.js");
            const objectStore = new ObjectStore(db, encryptionSecret, repositoryFactory);
            await objectStore.deleteByStoragePath(file.storage_config_id, file.storage_path, { db });
          } catch (deleteError) {
            console.error(`删除存储文件失败 (ID: ${id}):`, deleteError);
          }
        }
      })().catch((deleteError) => {
        console.error(`删除文件存储失败 (ID: ${id}):`, deleteError);
      });

      if (userType === UserType.ADMIN) {
        await fileRepository.deleteFilePasswordRecord(id);
      }
      await fileRepository.deleteFile(id);

      result.success++;
    })().catch((error) => {
      console.error(`删除文件失败 (ID: ${id}):`, error);
      result.failed.push({ id, error: error.message || "删除失败" });
    });
  }

  for (const storageConfigId of storageConfigIds) {
    invalidateFsCache({ storageConfigId, reason: "files-batch-delete", db });
  }

  return jsonOk(c, result, `批量删除完成，成功: ${result.success}，失败: ${result.failed.length}`);
});

  router.put("/api/files/:id", requireFilesAccess, async (c) => {
    const db = c.env.DB;
    const { type: userType, userId } = getFilesPrincipal(c);
    const { id } = c.req.param();
    const body = await c.req.json();

    const result = await updateFile(db, id, body, { userType, userId });
    return jsonOk(c, result, result.message);
  });
};
