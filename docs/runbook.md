# Run n8n in production

This runbook covers setting up the server once, starting the stack, and the tasks and fixes you need after that.

## Before you start

You need these on the server:

- Debian 13, joined to the tailnet with Tailscale.
- Docker Engine with the compose plugin.
- Sysbox, which registers the `sysbox-runc` runtime with Docker.
- `sops` at `/usr/local/bin/sops`, plus `age`, `jq`, and `git`.

You also need:

- A DNS record that points `n8n.pastelpink.dev` at the server's tailnet IP (`tailscale ip -4`).
- A tailnet policy that allows Funnel for the `n8n-webhooks` device.
- A Tailscale auth key and a Cloudflare API token that can edit DNS for `pastelpink.dev`.
- A local copy of this repo with `mise install` done. You run `init.sh` there, not on the server.

## Set up the server

Do these steps once.

1. Clone the repo into `/opt/n8n-workflows`. The systemd unit expects this path.

   ```sh
   sudo git clone https://github.com/No767/n8n-workflows.git /opt/n8n-workflows
   ```

2. Create the server's age key and store it encrypted:

   ```sh
   age-keygen | sudo systemd-creds encrypt --name=age.key - /etc/credstore.encrypted/age.key
   ```

   `age-keygen` prints `Public key: age1...`. Copy that key.

3. On your machine, add the key from step 2 to `.sops.yaml` as a new entry under `keys`, then list it under `key_groups`:

   ```yaml
   keys:
     - &noelle age1gfw0l0jf8m4j2fmpwldqm6ckxvvlwmvy8t3563yh3xc8rscp4ssszmykyf
     - &prod age1...

   creation_rules:
     - path_regex: '\.sops\.yml$'
       key_groups:
         - age:
             - *noelle
             - *prod
   ```

4. On your machine, create the secrets file:

   ```sh
   ./init.sh
   ```

   It asks for the Tailscale auth key and the Cloudflare API token. If `secrets.sops.yml` already exists, run `sops updatekeys secrets.sops.yml` instead.

5. Put `secrets.sops.yml` on the server at `/opt/n8n-workflows/secrets.sops.yml`. It's encrypted, so you can commit it or copy it with `scp`.

6. Install the certificate renewal timer:

   ```sh
   sudo systemctl link /opt/n8n-workflows/configs/systemd/n8n-certs.service /opt/n8n-workflows/configs/systemd/n8n-certs.timer
   sudo systemctl enable --now n8n-certs.timer
   ```

7. Get the first certificate. nginx won't start without it.

   ```sh
   sudo systemctl start n8n-certs.service
   ```

   This takes about a minute. `journalctl -u n8n-certs.service` shows `Successfully received certificate` when it's done.

8. Point the editor domain at nginx. The unit runs as the `tailscale-serve` user, which must be the Tailscale operator to change the serve config:

   ```sh
   sudo useradd --system --no-create-home --shell /usr/sbin/nologin tailscale-serve
   sudo tailscale set --operator=tailscale-serve
   sudo systemctl link /opt/n8n-workflows/configs/systemd/tailscale-serve.service
   sudo systemctl enable --now tailscale-serve.service
   ```

   `tailscale serve status` lists port 443 forwarding to `tcp://127.0.0.1:443`.

## Start the stack

```sh
sudo /opt/n8n-workflows/run.sh
```

The script waits until every service passes its health check, then prints:

```
==> starting docker compose stack
...
==> the stack is up
```

The first start pulls every image, so it can take a few minutes. After that, n8n takes about a minute to become healthy.

## Check that it works

1. List the services:

   ```sh
   sudo docker compose -p n8n ps
   ```

   Every service shows `Up`, and most show `(healthy)`. `sandbox-runner-1` has no health check, so it shows `Up` only. `sandbox-certs` doesn't appear because it exits after it creates the sandbox TLS certificates.

2. From a device on the tailnet, open https://n8n.pastelpink.dev. On the first visit, n8n asks you to create the owner account.

3. Activate a workflow with a webhook trigger, then call it from outside the tailnet:

   ```sh
   curl -X POST https://n8n-webhooks.taile2ba99.ts.net/webhook/<path>
   ```

## Everyday tasks

### Update

```sh
git -C /opt/n8n-workflows pull
sudo /opt/n8n-workflows/run.sh
```

Compose recreates only the containers whose config or image changed.

### Change secrets

On your machine, run `./init.sh` again. It keeps the existing values and only generates or asks for missing ones.

To replace the Tailscale auth key or the Cloudflare API token, run `./init.sh --rotate-tokens`. It asks for both again. Press enter at a prompt to keep the current value.

To replace the runner, sandbox, and SearXNG keys, run `./init.sh --rotate`. After you deploy the new file, force-recreate the containers so they read the new values.

Put the new `secrets.sops.yml` on the server, then run `run.sh`.

### View logs

```sh
sudo docker logs -f n8n
```

The other containers are `n8n_runners`, `n8n_sandbox_api`, `n8n_sandbox_runner_1`, `n8n_searxng`, `n8n_database`, `n8n_nginx`, and `n8n_tailscale`.

### Stop the stack

```sh
sudo docker compose -p n8n stop
```

> [!WARNING]
> Never run `docker compose down -v`. It deletes the database volume and every workflow with it.

### Renew certificates

The timer runs every day and renews the certificate when it's close to expiry. nginx reloads the new certificate on its own.

- See when it runs next: `systemctl list-timers n8n-certs.timer`
- See the last run: `journalctl -u n8n-certs.service`
- Renew now: `sudo systemctl start n8n-certs.service`

### Back up the database

```sh
sudo docker exec n8n_database pg_dump --username=postgres n8n > n8n-$(date +%F).sql
```

Keep `secrets.sops.yml` and your own age key with the backups. Without `N8N_ENCRYPTION_KEY`, n8n can't decrypt the credentials stored in the dump.

## When something breaks

| Symptom                                                     | Fix                                                                                                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `error: run as root via sudo`                               | Run `sudo ./run.sh`.                                                                                                                  |
| `error: ... secrets.sops.yml not found`                     | Do steps 4 and 5 of the setup.                                                                                                        |
| `error: sysbox-runc isn't a registered docker runtime`      | Install Sysbox, then run `sudo systemctl restart docker`.                                                                             |
| sops can't decrypt `secrets.sops.yml`                       | Check that `.sops.yaml` has the server's public key and that `sops updatekeys secrets.sops.yml` ran after you added it.               |
| `run.sh` fails because a container is unhealthy             | Read that container's logs with `sudo docker logs <container>`.                                                                       |
| nginx restarts over and over with `cannot load certificate` | Run `sudo systemctl start n8n-certs.service`, then `run.sh`.                                                                          |
| The editor doesn't load                                     | Read `systemctl status tailscale-serve.service` on the server. Check that the DNS record matches `tailscale ip -4`.                   |
| A webhook returns 404                                       | The path must start with `/webhook/`.                                                                                                 |
| A webhook returns 405 or 429                                | Webhooks accept only `POST` (405). A client that sends more than 5 requests a second, after a burst of 10, hits the rate limit (429). |
| The webhook host doesn't respond                            | Read `sudo docker logs n8n_tailscale`. Check that the tailnet policy allows Funnel for `n8n-webhooks`.                                |
| Certificate renewal fails                                   | Read `journalctl -u n8n-certs.service`. Check that the Cloudflare token can still edit DNS for `pastelpink.dev`.                      |
