# OnMind-PRE

> **Declarative substitute for shell scripts and the locally executable subset of pipelines**

**Predefined Rutinme Environment (PRE)**. A way to prepare and make progressive development, such as scaffolding or local deploy, using **YAML** and linking **Bash** commands in a blueprint. It is a simple **CI/CD** tool also (in its foundations) but starts before of that.

> Basically, the way to operate consists in a **YAML** file where you define **variables** and **steps** with commands (bash sentences), then you are under your imagination (e.g. you can mix with scripts in javascript or python for more elaborated processes, like Service-Connections)

## Setting

To use **OnMind-PRE**, first set a `_pre.yml` (or in another folder and name) with the following specification example (is similar to basic aspects of **Azure Pipelines**):

```yml
# Comment or Title
variables:
- name: name
  value: there
- name: color
  valueFrom: gum choose "Blue" "Green" "Pink" "Red" "White" "Yellow"

steps:
- bash: echo "Hi ${name}"
  displayName: Hello
- bash: echo 'Your color is ${color}'
```

In this way...

- `${name}` and `${color}` are used to replace varariables by its values.  
- `valueFrom` allow reads by `bash` command using `gum` as dependency (like in the example, but isn't Azure Pipelines compatible).  
- Variables also accept Azure Pipelines macro syntax `$(name)` besides `${name}`.
- Steps accept `continueOnError: true/false` per step (Azure-style), falling back to the `--continue-on-error` global flag.

> A step must define exactly one of `bash`, `checkout`, `copy`, `delete` or `fetch`

### Native prompts (`ask`)

If `valueFrom` starts with the reserved word `ask`, the value is read with a native prompt (no external binary needed). Anything else (including `gum ...`) still runs as a shell command:

```yml
variables:
- name: color
  valueFrom: ask select "Blue" "Green" "Pink"
- name: tags
  valueFrom: ask multiselect "frontend" "backend" "docs"
- name: deploy
  valueFrom: ask confirm "Deploy to production?"
- name: username
  valueFrom: ask text "Your name"
- name: token
  valueFrom: ask password
```

> Supported commands: `select` (alias `choose`), `multiselect` (alias `multi`), `confirm`, `text` (alias `input`), `password`.  
> `confirm` stores `"true"`/`"false"`; `multiselect` stores one selection per line (like `gum choose --no-limit`).  
> `ask` requires an interactive terminal.

Try it with the bundled example (uses `ask select`, no `gum` needed):

```bash
bun main.ts --config examples/pre_ask.yml
```

### Arguments (`--set`)

For non-interactive runs (scripts, CI), feed variables from the command line instead of prompting:

```bash
bun main.ts --config deploy.yml --set env=prod --set tag=v2
```

```yml
variables:
- name: env
  valueFrom: arg        # key defaults to the variable name (= --set env=...)
- name: tag
  valueFrom: arg:tag    # explicit key
  default: latest       # fallback when --set is absent
- name: token
  valueFrom: env:API_TOKEN  # from the environment (CI secrets friendly)
```

> Precedence: `--set` wins over anything declared in the file. `arg:` without matching `--set` (and without `default:`) fails fast with a clear error; same for unset `env:`.

### Values from files

Variables can also be sourced from files (same `default:` fallback rules as above):

```yml
variables:
- name: token
  valueFrom: dotenv:.env:API_TOKEN  # KEY from a dotenv file (comments, quotes, `export` supported)
- name: version
  valueFrom: file:VERSION           # whole file content, trimmed
```

> The path can reference variables resolved earlier (e.g. `dotenv:${envDir}/.env:KEY`). Missing file or KEY fails fast unless `default:` is set.

### Checkout

A step can clone a repository instead of running a `bash` command (homologated with Azure Pipelines `steps.checkout`:

```yml
steps:
- checkout: https://github.com/${repo}.git
  path: ../output
  displayName: Clone / Checkout
- checkout: none
  displayName: No sources
```

> `path` defaults to `./<repo-name>` derived from the URL. If the path already exists the clone is skipped, unless `clean: true` (removes it and clones fresh). `branch: <name>` selects the branch (PRE extension). `fetchDepth: 1` downloads only the current version (shallow clone; `0`/unset = full history). Variables accept both `${var}` and `$(var)`, and `displayName`, `continueOnError` and `parallel` work as with `bash` steps.

### Conditions

A step can declare when it runs (homologated with Azure Pipelines `condition`):

```yml
steps:
- bash: "echo 'deploying to ${env}'"
  condition: eq('${env}', 'prod')
- bash: "echo 'cleanup'"
  condition: always()
```

> Supported: `always()`, `succeeded()`, `not()`, `and()`, `or()`, `eq()`, `ne()`, `contains()`, `startsWith()`, `endsWith()`. Variable refs can use `'$(var)'`, `'${var}'` (quoted) or bare `variables['var']` / `variables.var`; unknown variables expand to empty string. A false condition skips the step. NOTE (v1): `failed()` is accepted but always false — dynamic failure tracking is planned.

### Files

Steps can copy or delete files instead of running `bash` (homologated with Azure `CopyFiles@2` / `DeleteFiles@1`:

```yml
steps:
- copy: ./templates
  target: ./output
  contents:
  - "**/*.yml"
  - "!**/node_modules/**"
  clean: true
  displayName: Copy templates
- delete: ./output/**/*.tmp
  displayName: Clean temp files
```

> `target` is always a directory (created if missing). `contents` defaults to all files (`dotfiles` included); `!` negates a pattern. `clean: true` removes the target first; `overwrite: false` keeps existing files. `delete` accepts a literal path/dir or a glob relative to the working directory. Variables accept both `${var}` and `$(var)`, and `displayName`, `condition`, `continueOnError` and `parallel` work as with `bash` steps.

### HTTP

No `curl`/`jq` needed (native `fetch`, PRE-native — neither Azure nor GHA has a generic HTTP step). Variables can be fetched from an API, and steps can download files or call APIs:

```yml
variables:
- name: tag
  valueFrom: https://api.github.com/repos/myorg/myrepo/releases/latest | .tag_name
  headers:
    Authorization: Bearer ${GITHUB_TOKEN}
```

```yml
steps:
- fetch: https://example.com/pkg.tgz
  path: ./downloads/pkg.tgz
  displayName: Download package
- fetch: https://api.example.com/deploy
  method: POST
  headers:
    Authorization: Bearer ${TOKEN}
  body: '{"tag":"${tag}"}'
  path: ./logs/deploy.json
```

> `valueFrom: "<url>"` returns the trimmed body, or the value at `"<url> | <selector>"` (`.a.b[0].c` syntax) parsed as JSON. `fetch:` saves raw bytes (`path` defaults to `./<basename-of-url>`). Non-2xx responses fail fast unless `default:` (variables) / `continueOnError` (steps) is set. `timeout:` (seconds, default 30) applies to both. Secrets stay out of the file by sourcing header values from `env:`/`arg:` params.

Try it with the bundled example (needs internet):

```bash
bun main.ts --config examples/pre_url.yml
```

## Lauching

To run **OnMind-PRE** from binaries just check [**release**](https://github.com/kaesar/onmind-pre/releases) in this repo and download the file for your system. Then, launch the app like this:

```bash
./onmind-pre-mac --config examples/pre_app.yml
```

> `onmind-pre-mac` is the version for **macOS**, but it could be `onmind-pre-win` for **Windows**, even a version for **Linux**  
> `--config` is used to specify another path and file name for **YAML**

Alternatively, to run **OnMind-PRE** from sources, after clonning, launch the app like this:

```bash
bun install
bun main.ts --config examples/pre_app.yml
```

> You can add the `--config` argument with the path and `yml` file with configuration.  
> To use `gum` with `valueFrom` in `variables`, install it first, e.g.: `go install github.com/charmbracelet/gum@latest`

To compile **OnMind-PRE** into self-contained binaries (requires **Bun**):

```bash
bun build --compile ./main.ts --outfile onmind-pre-mac
bun build --compile --target=bun-linux-x64 ./main.ts --outfile onmind-pre-linux
bun build --compile --target=bun-windows-x64 ./main.ts --outfile onmind-pre-win.exe
```

## Troubleshooting

- **`YAMLException: bad indentation of a mapping entry`** — a `bash:` (or `checkout:`/`path:`) value contains `: ` unquoted, which YAML reads as a nested mapping. Quote the whole value:
  ```yml
  # Fails (`: ` inside the value)
  - bash: echo 'done: ${name}'
  # Works
  - bash: "echo 'done: ${name}'"
  ```
- **Raw stack dump on startup (`YAMLException ... Bun v...`)** — the YAML file itself is invalid. There is no friendly error yet: validate indentation, quotes and list dashes (`- `) in your `_pre.yml`.
