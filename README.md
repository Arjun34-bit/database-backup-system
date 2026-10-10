# PostgreSQL backups to Google Drive

Standalone CommonJS application for Windows and Node.js 22+. It creates a PostgreSQL custom archive, validates its table of contents, and streams it to a private personal Google Drive folder. Local archives and Drive backups are never automatically deleted. Only failed temporary `.partial` files are removed. Log files rotate independently of backups.

## Install and configure

1. Install Node.js **22 or newer** and PostgreSQL 18 command-line tools. Check `node --version`, `npm --version`, and the following in PowerShell:

   ```powershell
   & 'C:/Program Files/PostgreSQL/18/bin/pg_dump.exe' --version
   & 'C:/Program Files/PostgreSQL/18/bin/pg_restore.exe' --version
   ```

   Use PostgreSQL 18 tools for an 18 server. `pg_dump` cannot dump a server newer than its own major version; use the same major version for both tools. A successful dump does not guarantee compatibility with an older restore server.

2. From this project directory:

   ```powershell
   npm install
   Copy-Item .env.example .env
   ```

   A placeholder `.env` may already be supplied; edit it rather than replacing a configured file. Fill in database credentials and paths. `DB_NAME` must be a plain database name, not a connection string. The database account needs read access to all data being backed up. For a local server, use `127.0.0.1`. This configuration is intended for local PostgreSQL; remote deployments should add and verify their required TLS settings.

3. Create a [Google Cloud project](https://console.cloud.google.com/) and enable **Google Drive API** under APIs & Services → Library. In Google Auth Platform, configure branding and an **External** audience for a personal Google account. Add yourself as a test user while testing. Under Data Access add only `https://www.googleapis.com/auth/drive.file`.

4. Create an OAuth client with application type **Desktop app**. Put its client ID and client secret into `.env`. Do not use a service account for this personal Drive workflow. Run:

   ```powershell
   npm run authorize
   ```

   Open the displayed URL, sign into the intended Google account, and consent. The helper uses a loopback listener on `127.0.0.1`, a random state and PKCE. It saves the refresh token directly into `.env` without printing it. The five-minute listener is used only during setup. Scheduled jobs refresh access tokens automatically and never launch a browser. An External app in **Testing** generally has refresh tokens that expire after seven days for Drive scopes; move to Production for unattended use and follow any Google verification requirements presented for your app. Revoked tokens require repeating authorization. Keep credentials out of screenshots, shell history and source control.

5. Run `npm run drive:folder` once and put the returned ID into `GOOGLE_DRIVE_FOLDER_ID`. This creates an app-accessible private folder in My Drive. With the least-privilege `drive.file` scope, pasting an arbitrary existing folder ID is insufficient: that folder must have been created by this app or explicitly selected through Google Picker with the same app. The included helper avoids needing Picker or broad Drive access. In a folder URL, the ID is the portion after `/folders/`. Keep the folder unshared; the uploader rejects visible non-owner permissions. Never put it under a shared parent or change its sharing later.

All paths in `.env` can use forward slashes on Windows. Relative `BACKUP_DIR` is resolved against the project root, independent of the working directory. `.env` always loads from the project root; existing process environment values take precedence. Quote values containing `#`. Required settings and cron/timezone values are validated at startup. Timeouts and retry limits are documented in `.env.example`.

## Run

```powershell
npm run backup
npm start
```

The first command performs one dump and upload, then exits with code 0 on success or 1 on failure. The second keeps a scheduler running, defaulting to `0 2 * * *` in `Asia/Kolkata`. It logs the next execution in UTC with the schedule timezone. It does not run a backup immediately at startup or replay missed executions. `npm run dev` enables Node's development watch mode; do not use it for unattended operation.

File names include a UTC timestamp (with `Z`) and UUID to avoid collisions. Archives are written to a unique `.partial` path, checked for nonzero size, validated with `pg_restore --list`, and renamed to `.dump`. No failed or unvalidated archive is uploaded. Archive listing checks format/catalog readability, **not every data block or full restorability**; periodically restore to an isolated test database.

Uploads use 8 MiB resumable chunks with bounded exponential backoff and jitter. Interrupted transfers query the acknowledged offset before resending. Authentication, permission and storage-quota failures stop without indefinite retries. A `.dump.upload.json` sidecar records the reserved Drive ID, destination, size and MD5; preserve it with the dump. An ambiguous completed upload is reconciled using this ID rather than intentionally creating a duplicate. Size and available MD5 metadata are compared after upload. MD5 here is an integrity check, not encryption or a security signature.

If uploading fails, retry the completed archive without another database dump:

```powershell
npm run backup -- --retry-upload "C:/Users/USER/database-backup-system/backups/your-backup.dump"
```

This revalidates the archive and checks its upload record. An already completed upload returns verified metadata. A process restart begins a fresh resumable session for an incomplete upload using the same reserved file ID; byte-level session progress is not persisted. A scheduled execution always takes a new snapshot; it does not automatically drain earlier failed uploads. Logs include the preserved file path for manual retries. Do not modify an archive during upload or alter its sidecar. Deleting the sidecar loses deduplication across retries. No application can guarantee exactly-once behavior if its local state is lost.

An in-process lock and cron overlap prevention cover this Node process only. **Run one instance per configuration.** Separate shells or Task Scheduler instances do not share a lock. SIGINT/SIGTERM stop future scheduling and allow current work to finish; forced termination or power loss can leave a `.partial` file for manual inspection. PostgreSQL subprocesses and HTTP requests have bounded timeouts.

## Windows Task Scheduler

Use Task Scheduler if you do not keep Node running continuously:

1. Create a task under the Windows account that owns `.env` and the backup directory. Set a daily trigger for 02:00. Windows triggers use the machine's timezone; configure it appropriately if you want India time.
2. Action: program `C:\Program Files\nodejs\node.exe`; arguments `"C:\Users\USER\database-backup-system\scripts\test-backup.js"`; Start in `C:\Users\USER\database-backup-system` (adjust installation paths).
3. Select **Do not start a new instance** if already running, **Run task as soon as possible after a scheduled start is missed**, and optionally **Wake the computer to run this task**. Ensure network access and suitable battery/power conditions. Allow enough execution time for the largest dump and upload.
4. Choose whether to run when logged out, supply Windows credentials if requested, and run the task manually once. Check exit code and `logs/backup.log`.

Do not also run `npm start` against the same configuration. Neither scheduler runs while the computer is powered off. Wake timers depend on Windows/hardware policy; an in-process cron job cannot wake a sleeping computer. Monitor backup freshness externally for unattended use.

## Verify and restore

Check `logs/backup.log` for completion, file size and Drive file ID; failures also go to `logs/error.log`. Open the configured private folder in Drive and compare the archive name and size. Periodically download a backup, compare `Get-FileHash -Algorithm MD5`, and perform a real isolated restore. Keep the sidecar as a reference for the expected checksum.

For a restore drill, create a **new, empty** test database and run the following in PowerShell. `--password` prompts securely; do not put passwords on the command line:

```powershell
& 'C:/Program Files/PostgreSQL/18/bin/createdb.exe' --host 127.0.0.1 --username postgres --password restore_test
& 'C:/Program Files/PostgreSQL/18/bin/pg_restore.exe' --list 'C:/safe-path/backup.dump'
& 'C:/Program Files/PostgreSQL/18/bin/pg_restore.exe' --host 127.0.0.1 --username postgres --password --dbname restore_test --no-owner --no-privileges --exit-on-error 'C:/safe-path/backup.dump'
```

Confirm tables, row counts, extensions and application behavior before using a restored database. These commands intentionally omit destructive `--clean`. `--no-owner --no-privileges` makes a test restore portable; for a full recovery, provision the original roles and restore ownership/grants according to your deployment. `pg_dump` backs up **one database**, not cluster-wide roles or global objects. Plan a separate secured `pg_dumpall --globals-only` backup and restoration process if needed. Custom archives are portable logical backups, not point-in-time recovery/WAL backups.

## Secrets, local access and encryption

`.env`, dumps, sidecars and logs are ignored by Git. PostgreSQL receives its password only in a controlled child environment; `shell: false` and separate arguments prevent shell interpolation. This is not a defense against an administrator or another process with debugging rights. OAuth credentials are excluded from PostgreSQL's environment. Errors from Google transports are summarized instead of serializing token-bearing request objects. Restrict local files to the task account and administrators: POSIX mode bits in Node do **not** enforce Windows ACLs.

For a new installation, inspect and restrict ACLs in PowerShell (use the actual scheduled task account; review inherited entries with `icacls`):

```powershell
$backupAccount = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
icacls .env /inheritance:r /grant:r "${backupAccount}:(F)" "SYSTEM:(F)"
icacls backups /inheritance:r /grant:r "${backupAccount}:(OI)(CI)F" "SYSTEM:(OI)(CI)F"
icacls logs /inheritance:r /grant:r "${backupAccount}:(OI)(CI)F" "SYSTEM:(OI)(CI)F"
```

Review existing explicit permissions and apply appropriate ACLs to any custom `BACKUP_DIR`. Keep enough disk space: no retention cleanup is implemented. Decide manually when and where to archive old backups.

**The default pipeline uploads unencrypted `.dump` files.** Custom format compression is not encryption. Database backups can contain sensitive user and artist information; use client-side encryption before uploading sensitive production data. This implementation does not silently introduce key management or claim encrypted backups. A recovery-tested extension should encrypt the validated archive with a maintained tool such as GnuPG, upload only the encrypted artifact, and verify its size/checksum separately. For example, outside the default uploader:

```powershell
gpg --symmetric --cipher-algo AES256 --output backup.dump.gpg backup.dump
gpg --output recovered.dump --decrypt backup.dump.gpg
& 'C:/Program Files/PostgreSQL/18/bin/pg_restore.exe' --list recovered.dump
```

Let GnuPG prompt for the passphrase; never put it in a command argument. Store recovery keys/passphrases offline or in a separate password manager, document who can recover them, and periodically decrypt and restore a downloaded encrypted backup. The supplied `.dump` uploader does not accept `.gpg`; do not enable this application's plaintext scheduled uploads if your policy requires encryption. BitLocker protects local storage but is not client-side encryption for Drive.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Missing configuration | Fill the named variable in `.env`; placeholders are rejected. |
| Binary cannot start | Check full `.exe` paths, installation and task account permissions. |
| Server connection/authentication fails | Check service status, host/port, `pg_hba.conf`, password and account access. |
| Version mismatch | Install client tools matching the server major version; configure both paths. |
| Disk full / permission denied | Free or provision space manually, check directory ACLs; completed archives are preserved. |
| Invalid/revoked refresh token | Repeat `npm run authorize`; check Testing-mode expiration and intended Google account. |
| Folder not found / 403 | Use the app-created private folder, enable Drive API, check quota and OAuth client identity. |
| Drive storage quota full | Increase storage or manage files yourself; this app never deletes Drive backups. |
| Network interruption | Bounded retries run first; use `--retry-upload` with the preserved archive afterward. |
| Checksum / size mismatch | Preserve both artifacts; inspect manually. Existing Drive IDs are never overwritten. |
| Backup skipped | A job is already running; check duration and stop duplicate processes/tasks. |
| No scheduled execution | Keep the process and machine awake, inspect timezone, or use Task Scheduler. |

Run `npm test` for offline tests. They use fake PostgreSQL processes and Drive transports; a live database/Drive smoke test and isolated restore drill remain necessary with your credentials.

## References

- [PostgreSQL 18 pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html)
- [Drive upload protocol](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
- [Least-privilege Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Desktop OAuth flow](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Refresh-token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration)
- [node-cron scheduling options](https://nodecron.com/scheduling-options.html)
