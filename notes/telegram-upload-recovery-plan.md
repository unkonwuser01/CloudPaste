# Telegram Upload Recovery Plan

## Goal

Stabilize CloudPaste Telegram storage updates without breaking normal uploads.

Two workstreams must stay isolated:

- **A-line: restore and lock normal uploads**
- **B-line: investigate and fix large-file timeout / late-success behavior**

Do not mix them in one round of edits.

---

## Current Recovery Baseline

Use this local commit as the current recovery backup point:

- `2819d2b2` — `chore(local): snapshot current Telegram upload recovery state`

Do not discard this baseline until a strictly better verified state exists.

---

## Core Rules

1. **No more iterative hot-patching inside the running backend container** for Telegram upload logic.
2. All code changes should happen in source under `/home/fengshan/CloudPaste` first.
3. Validate in a controlled step before treating a change as good.
4. If a change breaks normal upload paths, stop and roll back immediately.
5. Treat **multipart upload compatibility**, **fetch implementation**, **undici/dispatcher behavior**, and **large-file timeout behavior** as separate concerns.

---

## A-line: Restore and Lock Normal Uploads

### Target

Make sure normal uploads remain stable:

- WebDAV direct upload works
- `/api/share/upload` works
- small image upload works
- small video upload works
- normal document upload works

### A-line Exit Criteria

A-line is considered stable only if all of the following pass:

1. small JPG upload returns success
2. small MP4 upload returns success
3. normal document upload (for example APK or ZIP) returns success
4. uploaded object remains readable / downloadable

### A-line Stop-Loss Conditions

If any of the following appears, stop immediately and roll back to the recovery baseline:

- `Bad Request: there is no document in the request`
- WebDAV direct upload returns 500
- `/api/share/upload` returns 500
- backend fails to start normally
- multipart/form-data body appears malformed

### A-line Notes

- Do **not** optimize timeout behavior during A-line work.
- Do **not** touch `getFile` / `getFileInfo` during A-line unless they directly break normal upload validation.
- Do **not** introduce runtime dependency experiments while A-line is still unstable.

---

## B-line: Large File Failure Investigation

### Target

Handle the original large-file problem safely:

- avoid front-end 500 while Telegram backend is still uploading
- avoid late success without index registration
- resolve `getFile` / `getFileInfo` follow-up failures if they are part of the large-file path

### B-line Preconditions

Do **not** start B-line until A-line is stable.

### Required Working Method

Create an isolated branch before B-line work:

```bash
cd /home/fengshan/CloudPaste
git checkout -b fix/telegram-large-upload-timeout
```

### B-line Order

#### B1. Only inspect `sendDocument` waiting / timeout behavior

Allowed:
- request waiting behavior
- timeout boundaries
- front-end request lifecycle observation

Not allowed yet:
- changing multipart request construction
- swapping fetch implementation casually
- introducing new dispatcher behavior into all Telegram API calls
- changing `getFile` and `sendDocument` together in one step

#### B2. If front-end still fails but backend later succeeds

Prefer evaluating a recovery design such as:
- automatic post-success indexing / registration
- delayed reconciliation
- explicit success detection followed by index补建

This may be safer than continuing to alter low-level request internals.

#### B3. Only after B1/B2 are understood, inspect `getFile` / `getFileInfo`

Check separately:
- whether `getFile` is actually required in the failing path
- whether `getFile` can be retried independently
- whether download URL reconstruction can be isolated from upload success handling

---

## Validation Matrix (Run Every Time)

For every meaningful code change, run this minimum matrix:

1. small JPG upload
2. small MP4 upload
3. normal document upload (APK/ZIP)
4. read/download the uploaded object

Only if all four pass should the change be considered safe enough to continue.

If working on B-line, add:

5. one large-file upload observation run
6. confirm whether front-end result matches backend actual result
7. confirm whether index registration is complete

---

## Rollback Procedure

If the current work breaks normal upload behavior:

```bash
cd /home/fengshan/CloudPaste
git reset --hard 2819d2b2
```

Then restore the runtime from source again in a controlled way.

---

## What Went Wrong Previously

Summary of the previous failure pattern:

1. the investigation direction was broadly reasonable
2. but the implementation strategy became too aggressive
3. timeout handling, fetch implementation, multipart behavior, and dispatcher/runtime compatibility were changed too close together
4. hot-patching the running container made state verification messy
5. the problem scope expanded from “large-file behavior” into “all Telegram uploads may break”

Key lesson:

> Shrink the problem surface. Do not broaden it while the production path is still unstable.

---

## Recommended Operating Discipline

Before every risky change:

1. ensure a backup commit exists
2. make the change in source only
3. restart / rebuild in a controlled step
4. run the validation matrix
5. stop immediately if normal upload regresses

---

## Short Execution Sequence

1. keep `2819d2b2` as rollback anchor
2. verify current normal upload behavior
3. stabilize A-line completely
4. branch for B-line
5. test only one variable at a time
6. prefer reconciliation/index recovery over broad transport-layer rewrites when possible
