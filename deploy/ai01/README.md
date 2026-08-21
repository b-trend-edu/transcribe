# transcribe on ai01

On-prem GPU box, `10.1.10.11`. RTX 4070 (16 GB), i5-12600K, 19.4 GiB RAM.

## Before you start

**1. Extend the disk.** Root is 47 GB of a 100 GB bootdisk and already 79% full.
The CUDA image alone is 15–25 GB and will not fit.

```sh
sudo vgs                       # confirm free space in the volume group
sudo lvextend -l +100%FREE /dev/ubuntu-vg/ubuntu-lv
sudo resize2fs /dev/ubuntu-vg/ubuntu-lv
df -h /
```

**2. Confirm Docker can reach the GPU.** `nvidia-smi` working does NOT prove the
container toolkit is installed.

```sh
docker run --rm --gpus all nvidia/cuda:12.8.1-base-ubuntu22.04 nvidia-smi
```

If that fails with `could not select device driver "nvidia"`, install
`nvidia-container-toolkit` and `nvidia-ctk runtime configure --runtime=docker`,
then restart Docker.

**3. Be logged in to GHCR** (`docker login ghcr.io`).

## Deploy

```sh
sudo mkdir -p /opt/transcribe && sudo chown "$USER" /opt/transcribe
cp docker-compose.yml setup.sh /opt/transcribe/
cd /opt/transcribe
./setup.sh                     # prompts for the BBB secret, generates .env
docker compose pull
docker compose up -d
docker compose logs -f app
```

Health: `curl http://127.0.0.1:3000/` → `{"status":"ok"}`
API docs: `http://<BIND_IP>:3000/scalar`
Inngest dashboard: `http://<BIND_IP>:8288`

## How this differs from `docker-compose.prod.yaml`

| | prod (Coolify) | ai01 |
|---|---|---|
| Bind | `${TAILSCALE_IP}` | `${BIND_IP}`, default `127.0.0.1` — no tailnet here |
| Recordings | bind-mounts BBB's published dir | **no mount**; BBB is remote, media over HTTPS |
| `RECORDINGS_DIR` | `/recordings` | **empty** |
| Batch size | 16 | 8 — 16 GB VRAM, not 32 |
| App memory | 16g | 12g — host has 19.4 GiB total |
| Language | auto-detect | `de` |

## Known constraints

- **No `/recordings` mount.** BBB runs at `bbb.otterdeploy.com`, so the disk-scan
  discovery path (`scanRecordings`) has nothing to scan. Discovery is the
  `getRecordings` API sweep only, and media is downloaded over HTTPS. Recordings
  are ~2 GB for 6 hours, so expect a few minutes of download per job.
- **VRAM is the ceiling.** large-v3 + diarization is 10–13 GB of 16 GB. Nothing
  else may hold VRAM at the same time — including Ollama, which runs on this host.
  Set a short `OLLAMA_KEEP_ALIVE` so it releases memory between jobs.
- `TRANSCRIBE_CONCURRENCY` is pinned to 1 and should stay there.
