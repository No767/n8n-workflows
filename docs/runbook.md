# Run n8n in production

This runbook covers setting up the server once, starting the stack, and the tasks and fixes you need after that.

## Before you start

You need these on the server:

- Debian 13, joined to the tailnet with Tailscale.
- Docker Engine with the compose plugin.
- Sysbox, which registers the `sysbox-runc` runtime with Docker.
- `sops` at `/usr/local/bin/sops`, plus `age`, `jq`, and `git`.
- `yq` v4 from https://github.com/mikefarah/yq at `/usr/local/bin/yq`. Debian's `yq` package is a different tool and doesn't work.

You also need:

- A DNS record that points `n8n.pastelpink.dev` at the server's tailnet IP (`tailscale ip -4`).
- A tailnet policy that allows Funnel for the `n8n-webhooks` device.
- A Tailscale auth key and a Cloudflare API token that can edit DNS for `pastelpink.dev`.
- A BorgBase repository with no SSH key assigned yet. Copy its URL from the **Name** column: `ssh://<id>@<id>.repo.borgbase.com/./repo`.
- A Healthchecks.io check with **Period** set to 1 day and **Grace Time** set to 2 hours. Copy its ping URL: `https://hc-ping.com/<uuid>`.
- A local copy of this repo with `mise install` done, `curl`, and `mkpasswd` from Debian's `whois` package. You run `init.sh` there, not on the server.

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

4. On your machine, create the secrets file. First, print BorgBase's host keys and their fingerprints:

   ```sh
   ssh-keyscan -t ed25519,rsa <id>.repo.borgbase.com | tee /dev/stderr | ssh-keygen -lf -
   ```

   In BorgBase, hover over the fingerprint icon next to the repository. If neither printed fingerprint matches it, stop. Then run:

   ```sh
   ./init.sh
   ```

   It asks for these values:

   - **Tailscale Auth Key**: the Tailscale auth key.
   - **Cloudflare API Token**: the Cloudflare API token.
   - **BorgBase Repository URL**: the repository URL.
   - **BorgBase Host Key**: the `<id>.repo.borgbase.com ssh-ed25519 AAAA...` line that `ssh-keyscan` printed.
   - **Healthchecks Ping URL**: the check's ping URL.
   - **ntfy Server URL**: `http://ntfy`.
   - **ntfy Topic**: the topic for reminders, such as `canvas`.
   - **ntfy Alert Topic**: the topic for failure alerts, such as `canvas-alerts`.

   If `secrets.sops.yml` already has every value, run `sops updatekeys secrets.sops.yml` instead.

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

## Set up backups

In this section and the ones after it, `borgmatic <arguments>` on the server stands for:

```sh
sudo SOPS_AGE_KEY_CMD='systemd-creds decrypt /etc/credstore.encrypted/age.key' \
	sops exec-env /opt/n8n-workflows/secrets.sops.yml \
	"docker compose -f /opt/n8n-workflows/docker-compose.borgmatic.yml run --rm borgmatic <arguments>"
```

Do these steps once, after the stack is up.

1. If the server ran before backups existed, add the backup values to the secrets file. On your machine, run `./init.sh`. It asks only for the BorgBase and Healthchecks values from step 4 of [Set up the server](#set-up-the-server). Put the new `secrets.sops.yml` on the server, then do [Update](#update).

2. If the database existed before backups existed, create the `borgmatic` role. On your machine, print its password:

   ```sh
   sops decrypt --extract '["BORGMATIC_DB_PASSWORD"]' secrets.sops.yml
   ```

   On the server, open psql:

   ```sh
   sudo docker exec -it n8n_database psql --username=postgres --dbname=postgres
   ```

   Run these statements. At the `\password` prompt, paste the password.

   ```sql
   CREATE ROLE borgmatic LOGIN CONNECTION LIMIT 5 IN ROLE pg_read_all_data;
   GRANT CONNECT ON DATABASE n8n TO borgmatic;
   \password borgmatic
   ```

3. On your machine, print the public SSH key for BorgBase:

   ```sh
   sops decrypt --extract '["BORG_SSH_KEY"]' secrets.sops.yml | ssh-keygen -y -f /dev/stdin
   ```

   In BorgBase, add the `ssh-ed25519 AAAA...` line under **Account > SSH Keys**. Edit the repository and give the key **Full Access**.

4. On the server, create the Borg repository:

   ```sh
   borgmatic repo-create --encryption repokey-blake2
   ```

5. On the server, run `borgmatic key export`. Copy the key it prints to where you keep your age key.

6. On the server, install the backup timer:

   ```sh
   sudo systemctl link /opt/n8n-workflows/configs/systemd/n8n-borgmatic.service /opt/n8n-workflows/configs/systemd/n8n-borgmatic.timer
   sudo systemctl enable --now n8n-borgmatic.timer
   ```

7. On the server, run the first backup:

   ```sh
   sudo systemctl start n8n-borgmatic.service
   ```

   The command returns when the backup finishes. The check in Healthchecks turns green.

## Set up ntfy

ntfy sends the Canvas reminders and failure alerts to your phone and other devices. Do these steps once, after the stack is up.

1. If the server ran before ntfy existed, do [Add ntfy to a running server](#add-ntfy-to-a-running-server) first.

2. On your machine, print the password for the `devices` user and the two topics:

   ```sh
   sops decrypt --extract '["NTFY_DEVICES_PASSWORD"]' secrets.sops.yml
   sops decrypt --extract '["NTFY_TOPIC"]' secrets.sops.yml
   sops decrypt --extract '["NTFY_ALERT_TOPIC"]' secrets.sops.yml
   ```

3. On each device, install the ntfy app. Tap **+** and enter the reminder topic. Turn on **Use another server** and enter `https://n8n-webhooks.taile2ba99.ts.net`. Tap **Subscribe**. At the login prompt, enter `devices` and the password.

4. Subscribe to the alert topic the same way. The app doesn't ask for the login again.

5. On your machine, print the password for the `n8n` user:

   ```sh
   sops decrypt --extract '["NTFY_N8N_PASSWORD"]' secrets.sops.yml
   ```

6. On the server, send a test message. Replace `<topic>` with the reminder topic. At the `Enter Password:` prompt, paste the password.

   ```sh
   sudo docker exec -it n8n_ntfy ntfy publish --user n8n http://localhost/<topic> "Test from the server"
   ```

   Each device shows the message.

7. If the Canvas workflows already run on the server, create the ntfy credential from [Values for canvas.sops.yml](#values-for-canvassopsyml). Then do [Change an id](#change-an-id).

### Add ntfy to a running server

1. On your machine, run `./init.sh`. It asks only for the ntfy values from step 4 of [Set up the server](#set-up-the-server). Put the new `secrets.sops.yml` on the server. Don't run `run.sh` yet.

2. On your machine, print the password for the `ntfy` database role:

   ```sh
   sops decrypt --extract '["NTFY_DB_PASSWORD"]' secrets.sops.yml
   ```

3. On the server, open psql:

   ```sh
   sudo docker exec -it n8n_database psql --username=postgres --dbname=postgres
   ```

   Run these statements. At the `\password` prompt, paste the password.

   ```sql
   CREATE ROLE ntfy LOGIN CONNECTION LIMIT 30;
   CREATE DATABASE ntfy OWNER ntfy;
   REVOKE ALL ON DATABASE ntfy FROM public;
   GRANT CONNECT ON DATABASE ntfy TO ntfy, borgmatic;
   \connect ntfy
   ALTER SCHEMA public OWNER TO ntfy;
   REVOKE ALL ON SCHEMA public FROM public;
   GRANT ALL ON SCHEMA public TO ntfy;
   ALTER DEFAULT PRIVILEGES FOR ROLE ntfy REVOKE EXECUTE ON FUNCTIONS FROM public;
   \password ntfy
   ```

4. On the server, start ntfy:

   ```sh
   git -C /opt/n8n-workflows pull
   sudo /opt/n8n-workflows/run.sh
   ```

5. On the server, recreate nginx:

   ```sh
   sudo SOPS_AGE_KEY_CMD='systemd-creds decrypt /etc/credstore.encrypted/age.key' \
   	sops exec-env /opt/n8n-workflows/secrets.sops.yml \
   	"docker compose -f /opt/n8n-workflows/docker-compose.prod.yml up -d --wait --force-recreate nginx"
   ```

## Deploy the Canvas workflows

The Canvas workflows are Canvas Check, Canvas Sync, Canvas Alert, and Canvas Init. `workflows/build.sh` builds them into `workflows/dist/canvas.sops.json`. `run.sh --import` loads that file into n8n and publishes the workflows.

Before you start:

- The stack is up and the n8n owner account exists. See [Check that it works](#check-that-it-works).
- On your machine, run `aube install` in `workflows/`.

### Values for canvas.sops.yml

`workflows/init.sh` asks for these values and saves them in `workflows/canvas.sops.yml`.

| Prompt                                | Enter                                                                                                                                        |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Asana Project ID**                  | The number after `/project/` in the Asana project's URL.                                                                                     |
| **Asana Missed Section ID**           | The gid of the project's section for missed assignments. See [Find Asana gids](#find-asana-gids).                                            |
| **Google Calendar ID**                | In Google Calendar, open **Settings**, click the calendar, then copy **Calendar ID** under **Integrate calendar**.                           |
| **n8n Canvas Credential ID**          | The id of the **Header Auth** credential. Its **Name** is `Authorization` and its **Value** is `Bearer <Canvas token>`.                      |
| **n8n Asana Credential ID**           | The id of the **Asana OAuth2 API** credential.                                                                                               |
| **n8n Google Calendar Credential ID** | The id of the **Google Calendar OAuth2 API** credential.                                                                                     |
| **n8n ntfy Credential ID**            | The id of the **Basic Auth** credential for ntfy. Its **User** is `n8n` and its **Password** is `NTFY_N8N_PASSWORD` from `secrets.sops.yml`. |
| **n8n canvas_ledger Table ID**        | The id of the `canvas_ledger` data table. Leave it empty until `run.sh --init` creates the table.                                            |
| **n8n canvas_meta Table ID**          | The id of the `canvas_meta` data table. Leave it empty until `run.sh --init` creates the table.                                              |

To find an n8n id, open the credential or the data table in the server's n8n at https://n8n.pastelpink.dev. The id is the last part of the URL, after `/credentials/` or `/datatables/`. Data tables are under **Overview > Data tables**.

`workflows/init.sh` reads the gids of the Status and Priority fields from the Asana project and saves them under `asana.fields`. At the **Asana Personal Access Token** prompt, paste the token from [Add the Status and Priority fields](#add-the-status-and-priority-fields). `workflows/init.sh` doesn't save the token.

`workflows/init.sh` doesn't ask for the Canvas URL or the courses. Set them with `sops edit workflows/canvas.sops.yml`:

```yaml
canvas:
  base_url: https://<school>.instructure.com
courses:
  - id: 39187
    label: PHYS 008
    section: "<section gid>"
    tag: "<tag gid>"
    match:
      pattern: In Lecture Questions
      section: "<section gid>"
```

- `base_url`: the Canvas address, with no trailing `/`.
- `id`: the number after `/courses/` in the course's Canvas URL.
- `label`: the text in front of each Calendar event and ntfy reminder title.
- `section`: the gid of the Asana section for the course's assignments.
- `tag`: the gid of the Asana tag for the course. The tag must already exist.
- `match`: optional. Assignments whose name matches `match.pattern` go to `match.section` instead of `section`.
- `match.pattern`: a regular expression for the assignment name. It ignores case.
- `match.section`: the gid of the Asana section for the assignments that match. It's a different section from `section`.

### Find Asana gids

1. Create an Asana personal access token in the [Asana developer console](https://app.asana.com/0/my-apps).

2. On your machine, read the token into the shell. Paste it and press enter. It doesn't echo.

   ```sh
   read -rs ASANA_TOKEN
   ```

3. List the project's sections. Replace `<project gid>` with the number after `/project/` in the project's URL.

   ```sh
   curl -fsS --oauth2-bearer "$ASANA_TOKEN" 'https://app.asana.com/api/1.0/projects/<project gid>/sections?limit=100' \
   	| jq -r '.data[] | "\(.gid)  \(.name)"'
   ```

4. List the workspace's tags. Replace `<workspace gid>` with the number after `/1/` in the project's URL.

   ```sh
   curl -fsS --oauth2-bearer "$ASANA_TOKEN" 'https://app.asana.com/api/1.0/workspaces/<workspace gid>/tags?limit=100' \
   	| jq -r '.data[] | "\(.gid)  \(.name)"'
   ```

5. Clear the token with `unset ASANA_TOKEN`.

6. Put each gid in `workflows/canvas.sops.yml`. Each line of the output from steps 3 and 4 is a gid, then a name. Find the line with the name of the Asana section or tag, then copy the gid at the start of that line.

   | Copy the gid of                                                           | Output | Key                       | Set with                                           |
   | ------------------------------------------------------------------------- | ------ | ------------------------- | -------------------------------------------------- |
   | The Asana section for missed assignments                                  | Step 3 | `asana.missed_section`    | **Asana Missed Section ID** in `workflows/init.sh` |
   | The Asana section for the course's assignments                            | Step 3 | `courses[].section`       | `sops edit workflows/canvas.sops.yml`              |
   | The Asana tag for the course                                              | Step 4 | `courses[].tag`           | `sops edit workflows/canvas.sops.yml`              |
   | The Asana section for the course's assignments that match `match.pattern` | Step 3 | `courses[].match.section` | `sops edit workflows/canvas.sops.yml`              |

   For example, if step 3 prints `1219348633798299  PHYS 008`, set `section: "1219348633798299"` on the PHYS 008 course.

   `match.section` is also an Asana section gid from step 3. For example, if step 3 prints `1219348633798302  In Lecture Questions`, set `match.section: "1219348633798302"` on the PHYS 008 course.

### Add the Status and Priority fields

Canvas Sync sets a Status and a Priority on each Asana task. Add both fields to the Asana project before you run `workflows/init.sh`.

1. In the Asana project, add a single-select field named `Status` with these options: `Todo`, `In progress`, `Done`, and `Missed`.

2. In the same project, add a single-select field named `Priority` with these options: `Critical`, `High`, `Medium`, `Low`, and `None`.

3. Create an Asana personal access token in the [Asana developer console](https://app.asana.com/0/my-apps).

The field and option names must match exactly. Canvas Sync never sets `In progress`. Set it by hand in Asana.

### Deploy for the first time

1. In the server's n8n at https://n8n.pastelpink.dev, create the credentials listed in [Values for canvas.sops.yml](#values-for-canvassopsyml).

2. In Asana, do [Add the Status and Priority fields](#add-the-status-and-priority-fields).

3. On your machine, set the Canvas URL and the courses:

   ```sh
   sops edit workflows/canvas.sops.yml
   ```

4. On your machine, run `workflows/init.sh`. Leave both table ids empty. At the **Asana Personal Access Token** prompt, paste the token from step 2.

5. Revoke the token in the [Asana developer console](https://app.asana.com/0/my-apps).

6. On the server, create the data tables:

   ```sh
   git -C /opt/n8n-workflows pull
   sudo /opt/n8n-workflows/run.sh --init
   ```

7. In the server's n8n at https://n8n.pastelpink.dev, open Canvas Init's executions and check that the latest run succeeded. **Overview > Data tables** lists `canvas_ledger` and `canvas_meta`.

8. On your machine, run `workflows/init.sh` again. It asks only for the two table ids.

9. On your machine, build the workflows:

   ```sh
   workflows/build.sh
   ```

   The last line is `==> wrote .../workflows/dist/canvas.sops.json`.

10. Commit and push `workflows/canvas.sops.yml` and `workflows/dist/canvas.sops.json`.

11. On the server, import the workflows:

    ```sh
    git -C /opt/n8n-workflows pull
    sudo /opt/n8n-workflows/run.sh --import
    ```

    The last line is `==> published, n8n picks them up within about 10 s`.

12. In the server's n8n at https://n8n.pastelpink.dev, check that the four Canvas workflows are published. Canvas Check runs every minute. Its first run shows up in its executions within a minute.

### Deploy changed workflows

Do this after you change anything in `workflows/`, or the ntfy values in `secrets.sops.yml`.

1. On your machine, run `workflows/build.sh`.

2. Commit and push your changes and `workflows/dist/canvas.sops.json`.

3. On the server, import the workflows:

   ```sh
   git -C /opt/n8n-workflows pull
   sudo /opt/n8n-workflows/run.sh --import
   ```

### Add Status and Priority to running workflows

Do this once if the Canvas workflows ran on the server before the Status and Priority fields existed.

1. In Asana, do [Add the Status and Priority fields](#add-the-status-and-priority-fields).

2. On your machine, run `workflows/init.sh`. At the **Asana Personal Access Token** prompt, paste the token from step 1. The last line is `==> wrote .../workflows/canvas.sops.yml`.

3. Revoke the token in the [Asana developer console](https://app.asana.com/0/my-apps).

4. Do [Deploy changed workflows](#deploy-changed-workflows).

5. In the server's n8n at https://n8n.pastelpink.dev, open Canvas Check and click **Execute workflow**.

6. In Asana, check the tasks:

   - Open tasks show `Todo` and a Priority.
   - Missed tasks show `Missed` and `None`.
   - Done tasks show `Done` and `None`.

   Canvas Sync writes at most 30 changes to Asana per run. If some tasks still show no Status, wait for the next runs, about 5 minutes apart.

### Change an id

Do this when an id changes. A Status or Priority id changes when you delete and recreate the field or one of its options in Asana.

1. On your machine, run `workflows/init.sh --ask-all`. It asks for every value in [Values for canvas.sops.yml](#values-for-canvassopsyml). Press enter at a prompt to keep the current value. At the **Asana Personal Access Token** prompt, paste a token from the [Asana developer console](https://app.asana.com/0/my-apps).

2. Revoke the token in the Asana developer console.

3. Do [Deploy changed workflows](#deploy-changed-workflows).

If you reconnect or edit a credential in n8n and its id stays the same, you don't need to deploy.

## Everyday tasks

### Update

```sh
git -C /opt/n8n-workflows pull
sudo /opt/n8n-workflows/run.sh
```

Compose recreates only the containers whose config or image changed.

> [!NOTE]
> Compose doesn't recreate nginx when only `configs/nginx/nginx.conf` changed. If the pull changed that file, recreate nginx:
>
> ```sh
> sudo SOPS_AGE_KEY_CMD='systemd-creds decrypt /etc/credstore.encrypted/age.key' \
> 	sops exec-env /opt/n8n-workflows/secrets.sops.yml \
> 	"docker compose -f /opt/n8n-workflows/docker-compose.prod.yml up -d --wait --force-recreate nginx"
> ```

### Change secrets

On your machine, run `./init.sh` again. It keeps the existing values and only generates or asks for missing ones.

To replace the Tailscale auth key, the Cloudflare API token, the BorgBase repository URL or host key, the Healthchecks ping URL, or the ntfy server URL or topics, run `./init.sh --rotate-tokens`. It asks for all eight again. Press enter at a prompt to keep the current value.

To replace the runner, sandbox, and SearXNG keys, run `./init.sh --rotate`. After you deploy the new file, force-recreate the containers so they read the new values.

Put the new `secrets.sops.yml` on the server, then run `run.sh`.

If you changed an ntfy value, recreate ntfy on the server:

```sh
sudo SOPS_AGE_KEY_CMD='systemd-creds decrypt /etc/credstore.encrypted/age.key' \
	sops exec-env /opt/n8n-workflows/secrets.sops.yml \
	"docker compose -f /opt/n8n-workflows/docker-compose.prod.yml up -d --wait --force-recreate ntfy"
```

Then do [Deploy changed workflows](#deploy-changed-workflows). If you changed a topic, subscribe to the new topic on each device.

### View logs

```sh
sudo docker logs -f n8n
```

The other containers are `n8n_runners`, `n8n_sandbox_api`, `n8n_sandbox_runner_1`, `n8n_searxng`, `n8n_database`, `n8n_ntfy`, `n8n_nginx`, and `n8n_tailscale`. Read backup output with `journalctl -u n8n-borgmatic.service`.

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

The timer backs up the `n8n` and `ntfy` databases to BorgBase once a day. Each run keeps 7 daily, 4 weekly, 12 monthly, and 1 yearly archive and deletes the rest. Every 2 weeks, the run also checks the repository.

- See when it runs next: `systemctl list-timers n8n-borgmatic.timer`
- See the last run: `journalctl -u n8n-borgmatic.service`
- Back up now: `sudo systemctl start n8n-borgmatic.service`
- List the archives: `borgmatic repo-list`

If a run fails, `n8n-borgmatic.service` shows `failed` and Healthchecks alerts. If no run succeeds for 26 hours, Healthchecks alerts.

Keep `secrets.sops.yml`, the exported repository key, and your own age key somewhere other than the server. Without `N8N_ENCRYPTION_KEY`, n8n can't decrypt the credentials stored in the dump.

### Restore the database

1. Check that the latest archive has the dump:

   ```sh
   borgmatic list --archive latest
   ```

   The output lists `borgmatic/postgresql_databases/database/n8n` and `borgmatic/postgresql_databases/database/ntfy`. Don't run `borgmatic restore --dry-run`. It fails on borgmatic 2.1.9.

2. Stop n8n and ntfy so nothing writes to the databases during the restore:

   ```sh
   sudo docker compose -p n8n stop n8n runners ntfy
   ```

3. Restore the dump:

   ```sh
   borgmatic restore --archive latest
   ```

   It drops and recreates every table in the `n8n` and `ntfy` databases. Ignore warnings like `permission denied to analyze "pg_shseclabel"`.

4. Start n8n again with `sudo /opt/n8n-workflows/run.sh`.

## When something breaks

| Symptom                                                                   | Fix                                                                                                                                                                           |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `error: run as root via sudo`                                             | Run `sudo ./run.sh`.                                                                                                                                                          |
| `error: ... secrets.sops.yml not found`                                   | Do steps 4 and 5 of the setup.                                                                                                                                                |
| `error: sysbox-runc isn't a registered docker runtime`                    | Install Sysbox, then run `sudo systemctl restart docker`.                                                                                                                     |
| sops can't decrypt `secrets.sops.yml`                                     | Check that `.sops.yaml` has the server's public key and that `sops updatekeys secrets.sops.yml` ran after you added it.                                                       |
| `run.sh` fails because a container is unhealthy                           | Read that container's logs with `sudo docker logs <container>`.                                                                                                               |
| nginx restarts over and over with `cannot load certificate`               | Run `sudo systemctl start n8n-certs.service`, then `run.sh`.                                                                                                                  |
| The editor doesn't load                                                   | Read `systemctl status tailscale-serve.service` on the server. Check that the DNS record matches `tailscale ip -4`.                                                           |
| A webhook returns 404                                                     | The path must start with `/webhook/`.                                                                                                                                         |
| A webhook returns 405 or 429                                              | Webhooks accept only `POST` (405). A client that sends more than 5 requests a second, after a burst of 10, hits the rate limit (429).                                         |
| The webhook host doesn't respond                                          | Read `sudo docker logs n8n_tailscale`. Check that the tailnet policy allows Funnel for `n8n-webhooks`.                                                                        |
| Certificate renewal fails                                                 | Read `journalctl -u n8n-certs.service`. Check that the Cloudflare token can still edit DNS for `pastelpink.dev`.                                                              |
| `n8n-borgmatic.service` failed                                            | Read `journalctl -u n8n-borgmatic.service`, then find the error below.                                                                                                        |
| `network n8n_db-bridge declared as external, but could not be found`      | The stack isn't up. Run `run.sh`.                                                                                                                                             |
| `Host key verification failed.`                                           | Redo the host key check in setup step 4. Run `./init.sh --rotate-tokens` and paste the new line at **BorgBase Host Key**.                                                     |
| `Permission denied (publickey)`                                           | Do step 3 of [Set up backups](#set-up-backups).                                                                                                                               |
| `Failed to create/acquire the lock`                                       | If `systemctl is-active n8n-borgmatic.service` prints `inactive` or `failed`, run `borgmatic break-lock`.                                                                     |
| `pg_hba.conf rejects connection for host ..., user "borgmatic"`           | Run `run.sh`.                                                                                                                                                                 |
| `pg_dump: error: ... password authentication failed for user "borgmatic"` | Do step 2 of [Set up backups](#set-up-backups).                                                                                                                               |
| `error: yq is required`                                                   | Install `yq` v4. See [Before you start](#before-you-start).                                                                                                                   |
| `error: mkpasswd is required`                                             | Run `sudo apt install whois`.                                                                                                                                                 |
| `n8n_ntfy` logs show `password authentication failed for user "ntfy"`     | Do steps 2 and 3 of [Add ntfy to a running server](#add-ntfy-to-a-running-server).                                                                                            |
| The ntfy app shows 401 or asks for the login again                        | Enter `devices` and `NTFY_DEVICES_PASSWORD` from `secrets.sops.yml`.                                                                                                          |
| **ntfy schedule**, **ntfy cancel**, or **ntfy alert** returns 403         | Check that the ntfy credential's **User** is `n8n` and its **Password** is `NTFY_N8N_PASSWORD`. If you changed a topic, recreate ntfy. See [Change secrets](#change-secrets). |
| The ntfy app doesn't connect                                              | Read `sudo docker logs n8n_nginx`. Check that the tailnet policy allows Funnel for `n8n-webhooks`.                                                                            |
| `error: ... canvas.sops.json not found, run workflows/build.sh first`     | Do steps 1 and 2 of [Deploy changed workflows](#deploy-changed-workflows), then pull on the server.                                                                           |
| `error: the config is missing asana.fields`                               | Run `workflows/init.sh`. See [Add Status and Priority to running workflows](#add-status-and-priority-to-running-workflows).                                                   |
| `error: the config is missing <values>`                                   | Fill in the listed values. See [Values for canvas.sops.yml](#values-for-canvassopsyml).                                                                                       |
| `jq: error ...: the Asana project has no <name> field`                    | Add the field. See [Add the Status and Priority fields](#add-the-status-and-priority-fields). Then run `workflows/init.sh` again.                                             |
| `jq: error ...: the <name> field has no "<option>" option`                | Add the option, or rename it to the name in the error. Then run `workflows/init.sh` again.                                                                                    |
| `error: couldn't read the custom fields of Asana project <gid>`           | Check the token and the **Asana Project ID**. Then run `workflows/init.sh` again.                                                                                             |
| `last_error` in `canvas_ledger` shows a `400` error about a custom field  | Do [Change an id](#change-an-id).                                                                                                                                             |
| `error: tsc not found, run aube install first`                            | Run `aube install` in `workflows/`.                                                                                                                                           |
| sops can't decrypt `canvas.sops.json` on the server                       | Check that `.sops.yaml` lists the server's key for `\.sops\.json$`, then rebuild.                                                                                             |
| Canvas Init fails with `... is missing columns: ...`                      | Add the listed columns in **Overview > Data tables**. Then run Canvas Init with **Execute workflow**.                                                                         |
| A Canvas workflow fails with a credential or data table error             | Check the ids in [Values for canvas.sops.yml](#values-for-canvassopsyml), then do [Change an id](#change-an-id).                                                              |
