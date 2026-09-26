# Deployment — clinic server first, cloud later (R6a, ADR-036)

The system runs as three containers on one clinic machine: **db** (PostgreSQL 16),
**app** (this Next.js app; applies migrations and the idempotent seed on every start) and
**caddy** (HTTPS). Everything the clinic owns is in `deploy/data/` (database + patient
files + Caddy's certificate authority) — that folder is what backups protect and what a
later move to the cloud carries over. The code does not change for the move.

## 1. The machine
- Dedicated PC or small server (not a staff workstation): 4+ cores, 16 GB RAM, SSD,
  on a UPS. Linux (Ubuntu Server LTS) or Windows 11 Pro with Docker Desktop (WSL 2).
- Fixed IP on the clinic network. Open to the network only ports 443 (and 80, which just
  redirects). Do not expose it to the internet; remote access goes through a VPN.
- Internet access is needed for AI invoice reading and later iCare.

## 2. Install
```sh
git clone https://github.com/bnassli/dawali-medical.git /opt/dawali      # or C:\dawali
cd /opt/dawali/deploy
cp .env.example .env        # then edit: SITE_ADDRESS, passwords, admin, API key
docker compose up -d --build
docker compose ps           # db, app and caddy "healthy"/"running"
```
`SITE_ADDRESS` (e.g. `dawali.clinic.local`) must point to the server on every clinic PC:
a DNS entry on the clinic router, or a line `192.168.1.20 dawali.clinic.local` in each
PC's hosts file (`C:\Windows\System32\drivers\etc\hosts`).

## 2a. Windows server step by step (the clinic's choice)
1. Windows 11 Pro (or Windows Server 2022) on the dedicated PC; a local account used only
   for the server, with a strong password. Enable BitLocker on the disk (patient data).
2. Install **Docker Desktop** (WSL 2 backend). Settings → General: tick "Start Docker
   Desktop when you sign in". Docker Desktop only runs while that account is signed in,
   so set the account to sign in automatically after a restart (e.g. Sysinternals
   Autologon) and lock the screen (Win+L) — never sign it out.
3. Install **Git for Windows**, then in PowerShell:
   ```powershell
   git clone https://github.com/bnassli/dawali-medical.git C:\dawali
   cd C:\dawali\deploy
   copy .env.example .env      # edit with Notepad: SITE_ADDRESS, passwords, admin, API key
   docker compose up -d --build
   docker compose ps
   ```
   `.gitattributes` keeps the Linux scripts with LF endings, so the clone works as is.
4. As Administrator, once:
   `powershell -ExecutionPolicy Bypass -File C:\dawali\deploy\setup-windows.ps1 -OffsiteDir E:\dawali-backups`
   — opens 443/80 on the private network only, disables sleep, schedules the nightly
   backup (02:30) with a copy to the external disk.
5. Set the clinic network as "Private" in Windows (Settings → Network), give the server a
   fixed IP, and set Windows Update active hours to clinic hours so restarts happen at night.
6. Continue with sections 3–5 below. Restore on Windows:
   `powershell -ExecutionPolicy Bypass -File C:\dawali\deploy\restore.ps1 C:\dawali\deploy\backups\<date_time>`

The database lives in the Docker volume `dawali_pgdata` (PostgreSQL cannot run on an NTFS
folder); patient files and certificates stay in `deploy\data`. Backups use pg_dump, so
they never depend on where the volume is.

## 3. HTTPS certificate on the clinic PCs (once per PC)
Caddy creates the clinic's own certificate authority. Copy its root certificate from
`deploy/data/caddy/caddy/pki/authorities/local/root.crt` and install it on each PC:
Windows → double-click → Install Certificate → Local Machine → "Trusted Root Certification
Authorities". Then open `https://dawali.clinic.local` — no warning should appear.
The app refuses to run in production without this canonical HTTPS origin (ADR-023).

## 4. First sign-in
Sign in with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`, change the password, create the
staff accounts with their roles (Admin → Users), then remove `SEED_ADMIN_PASSWORD` from
`.env`.

## 5. Backups (mandatory)
- Linux: `deploy/backup.sh` from cron every night, e.g.
  `30 2 * * * /opt/dawali/deploy/backup.sh >> /var/log/dawali-backup.log 2>&1`
- Windows: scheduled by `setup-windows.ps1` (Task Scheduler → "Dawali Medical backup").
- Each backup = `database.dump` + `files.tar.gz` + `SHA256SUMS` in
  `deploy/backups/<date_time>/`, kept 30 days (`KEEP_DAYS`), and the dump is verified as
  readable before the backup is reported ok.
- Set `OFFSITE_DIR` to an external disk / NAS / synced folder so a copy leaves the server;
  on Linux set `BACKUP_GPG_RECIPIENT` to encrypt that copy (it contains patient data).
- **Test a restore every month** on a spare machine:
  `CONFIRM=yes deploy/restore.sh deploy/backups/<date_time>` (it replaces the database and
  files; the replaced files are kept aside).

## 6. Updates
```sh
cd /opt/dawali && deploy/backup.sh && git pull && cd deploy && docker compose up -d --build
```
Migrations run on start. Destructive migrations never run silently (CLAUDE.md #15): read
the release's migration notes in `docs/DATABASE.md` first.

## 7. Moving to the cloud later
Choose a provider with a data centre in Saudi Arabia (patient data; confirm PDPL / NCA /
MOH requirements with the clinic's compliance adviser). Then: take a backup, start the same
compose stack there (or managed PostgreSQL + the app container, and S3-compatible storage
behind the `FileStorage` interface), restore the backup, point `SITE_ADDRESS` to the new
address with a real certificate (remove `tls internal`), and switch the clinic PCs over.

## Not covered yet
iCare integration (R6b), monitoring/alerting, high availability.
