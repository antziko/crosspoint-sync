# Moving from koreader-sync-server to crosspoint-sync (Pi 5 + OpenMediaVault)

This fork of crosspoint-sync accepts everything the self-hosted koreader-sync-server
fork does: progress with the CrossPoint `position`, `/syncs/bookmarks` and `/syncs/stats`.
Devices sync exactly as before. Each upload is also shown in the web app at `/app/`.

| Old data | Where it shows in the app |
|---|---|
| Progress + position | Library, book page, Activity |
| Quote highlights | Clippings (the snippet first, then the full text after the book's next device sync) |
| Reading-time stats | Stats summary (total time, day calendar, streak), per-book time |
| Point bookmarks, dictionary history, flashcards | Synced between devices as before; not shown in the app |

Paths below use `/srv/dev-disk-by-uuid-XXXX` for your data disk. Replace it with yours
(OMV: **Storage > Shared Folders**, the "Absolute Path" column).

## 1. Prepare (SSH into the Pi)

Enable SSH in OMV under **System > SSH** if needed, then `ssh <user>@<pi-ip>`.

```sh
# Find the old server's container name (koreader/kosync image, port 7200)
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'
OLD=kosync            # <- the name from the line above

# Back up the old Redis database first
docker exec $OLD redis-cli save
docker cp $OLD:/var/lib/redis/dump.rdb ~/kosync-dump-$(date +%F).rdb
ls -l ~/kosync-dump-*.rdb
```

## 2. Folders

In OMV create a shared folder `appdata` on your data disk (skip if you have one). Then:

```sh
APP=/srv/dev-disk-by-uuid-XXXX/appdata/crosspoint-sync
sudo mkdir -p $APP/data
sudo chown -R 1000:1000 $APP/data   # the container runs as uid 1000
```

## 3. Build the image (once per update)

```sh
sudo apt-get install -y git          # if git is missing
sudo git clone -b feature/koreader-compat https://github.com/antziko/crosspoint-sync.git $APP/src
docker build -t crosspoint-sync:compat $APP/src     # 5-10 min on a Pi 5
```

To update later: `cd $APP/src && sudo git pull && docker build -t crosspoint-sync:compat .`,
then **Down** and **Up** in OMV (step 4).

## 4. Run it from OMV

**Services > Compose > Files > + (Create)**. Name: `crosspoint-sync`. File:

```yaml
services:
  crosspoint-sync:
    image: crosspoint-sync:compat
    pull_policy: never
    container_name: crosspoint-sync
    ports:
      - "8080:8080"
    volumes:
      - /srv/dev-disk-by-uuid-XXXX/appdata/crosspoint-sync/data:/data
    environment:
      REGISTRATION_DISABLED: "true"   # your account comes from the import
    restart: unless-stopped
```

Save, tick the row, press **Up**. Check from SSH:

```sh
curl http://localhost:8080/healthz      # {"status":"ok",...}
```

## 5. Import the old data

The importer reads the old Redis through the old container's network, so the old server
stays up and untouched.

```sh
APP=/srv/dev-disk-by-uuid-XXXX/appdata/crosspoint-sync
docker run --rm --network container:$OLD -v $APP/data:/data crosspoint-sync:compat \
  node dist/compat/import-redis.js --dry-run      # counts only
docker run --rm --network container:$OLD -v $APP/data:/data crosspoint-sync:compat \
  node dist/compat/import-redis.js                # real import
```

Re-running is safe: anything already newer in crosspoint-sync is skipped.

## 6. Check the web app

Open `http://<pi-ip>:8080/app/` and sign in with your **sync username and password**
(the same ones the devices use). Library, Clippings and Stats should show your old data.

## 7. Point the readers at it

CrossPoint device: **Settings > KOReader Sync**, add a server:

- URL `http://<pi-ip>:8080`, same username and password
- **Send Document Metadata: ON** (the Library needs titles)
- **Precise Position: ON**

Make it the active server, open a book and sync. Do the same on every device.

KOReader plugin: **CrossPoint sync > Server and login**, server `http://<pi-ip>:8080`.

## 8. Retire the old server

Keep it running but unused for a couple of weeks. When nothing has been missing, stop it
in OMV (or `docker stop $OLD`). Keep the `.rdb` backup from step 1.

## Notes

- Plain HTTP is fine inside your home network. For access from outside, put a TLS reverse
  proxy (e.g. Nginx Proxy Manager) in front and use its `https://` URL on the devices.
- Back up `$APP/data` (the SQLite database) with OMV's usual backup job.
- Delete highlights on a device, not in the web app: the next device sync restores a
  highlight that the device still has.
