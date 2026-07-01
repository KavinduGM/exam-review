# Creating the read-only MySQL users

The auditor only ever **reads** the client databases. Give it a `SELECT`-only user
on each of the three DBs. Do this from each database's Dokploy terminal
(**Open Terminal**), logged in as root.

> Replace `CHOOSE_A_STRONG_PASSWORD` with your own. Keep these passwords — they go
> into the auditor's Dokploy secrets, not into source control.

## Timed exams — `onlineexam_db`

```sql
CREATE USER 'auditor_ro'@'%' IDENTIFIED BY 'CHOOSE_A_STRONG_PASSWORD';
GRANT SELECT ON onlineexam_db.* TO 'auditor_ro'@'%';
FLUSH PRIVILEGES;
```

## New practice — `exam_db`

```sql
CREATE USER 'auditor_ro'@'%' IDENTIFIED BY 'CHOOSE_A_STRONG_PASSWORD';
GRANT SELECT ON exam_db.* TO 'auditor_ro'@'%';
FLUSH PRIVILEGES;
```

## Old practice — `answers_db`

```sql
CREATE USER 'auditor_ro'@'%' IDENTIFIED BY 'CHOOSE_A_STRONG_PASSWORD';
GRANT SELECT ON answers_db.* TO 'auditor_ro'@'%';
FLUSH PRIVILEGES;
```

(If these three databases share one MySQL server, you can create a single
`auditor_ro` user and run the three `GRANT` statements against it.)

## Wiring into the auditor

For each DB, set the matching `SRC_*` env vars (Dokploy secrets on the auditor app).
Use the **internal** Dokploy host (the container/service name shown in the DB's
General tab), e.g. `onlineexam-onlineexamdb-iqw9vd`:

```
SRC_TIMED_HOST=onlineexam-onlineexamdb-iqw9vd
SRC_TIMED_PORT=3306
SRC_TIMED_USER=auditor_ro
SRC_TIMED_PASSWORD=...
SRC_TIMED_DATABASE=onlineexam_db

SRC_PRACTICE_NEW_HOST=...        # exam_db internal host
SRC_PRACTICE_NEW_DATABASE=exam_db
SRC_PRACTICE_NEW_USER=auditor_ro
SRC_PRACTICE_NEW_PASSWORD=...

SRC_PRACTICE_OLD_HOST=...        # answers_db internal host
SRC_PRACTICE_OLD_DATABASE=answers_db
SRC_PRACTICE_OLD_USER=auditor_ro
SRC_PRACTICE_OLD_PASSWORD=...
```

For the auditor to reach those internal hosts, its app must be attached to the same
Docker network/project as the databases in Dokploy.

> Leaving any `SRC_*_HOST` blank disables cross-validation for that source — the
> auditor still works, falling back to site defaults and link probing.

## Revoking later

```sql
DROP USER 'auditor_ro'@'%';
```
