# dc-compose

Short, memorable shortcuts for `docker compose`, with TOML-to-YAML conversion support. Works on Linux, macOS and Windows.

```sh
npm install -g dc-compose
dc help
```

Requires Node 18+ and Docker with the Compose plugin.

## Examples

```sh
dc up build pull       # docker compose up -d --build --pull always
dc toml                # convert compose.toml to compose.yaml
dc toml up build web   # convert, then run up --build web
dc re web              # force-recreate one service
dc upgrade web         # pull + recreate just web
dc logs 50 web         # follow the last 50 lines of web
dc errs                # follow logs, only error/warn/fatal lines
dc sh web              # shell into web (bash, falling back to sh)
dc down vols           # docker compose down --volumes
dc ip                  # container IPs
```

Run `dc help` for the full command list.

`dc toml` converts `compose.toml` (or `docker-compose.toml`) to the
corresponding YAML file and validates it with Docker Compose. If validation
fails, the Docker error is shown and the project is not started. To start the
converted Compose project, use
`dc toml up`; arguments after `up` are passed to the `up` command, including
keywords such as `build`, `pull`, and `force`, or service names.

## Shell completion

```sh
# bash
dc completion bash >> ~/.bashrc

# zsh
dc completion zsh > ~/.zfunc/_dc    # ensure ~/.zfunc is in your fpath
```

## Choosing your editor

`dc edit` and `dc env` open files in your configured editor.

```sh
dc editor              # show the current editor and where it comes from
dc editor vim          # set it
dc editor code --wait  # extra arguments are kept
dc editor --unset      # clear it
```

Resolution order: `dc editor` setting, then `$VISUAL`, then `$EDITOR`, then `nano` (`notepad` on Windows).

The setting lives in `~/.config/dc/config.json` (`$XDG_CONFIG_HOME/dc/config.json` if set, `%APPDATA%\dc\config.json` on Windows). You can edit it by hand:

```json
{ "editor": "code --wait" }
```

Set `DC_CONFIG` to use a different file. If the path to your editor contains spaces, quote it inside the value:
`dc editor '"C:\Program Files\Microsoft VS Code\bin\code.cmd" --wait'`.

## Running the web server

On Linux with systemd, install and start the Compose Manager server:

```sh
dc server enable
```

This installs `dc-server.service` under `/etc/systemd/system`, enables it at boot,
and starts it immediately. `sudo` is required. The server listens on
`http://127.0.0.1:56213`.

To stop it, disable it, and remove the systemd unit:

```sh
dc server disable
```

The server command requires Linux with systemd; it is not available on Windows or macOS.

## Notes

- `dc prune` and `dc clean` ask for confirmation before deleting anything.
- A broken config file never blocks `dc edit`: it warns and falls back to `$VISUAL` / `$EDITOR`.

## License

[MIT](LICENSE) @ https://opensource.org/license/mit