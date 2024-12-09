# OnMind-PRE

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

> `${name}` and `${color}` are used to replace varariables by its values.  
> `valueFrom` allow reads by `bash` command using `gum` as dependency (like in the example).

## Lauching

To run **OnMind-PRE** from binaries just check [**release**](https://github.com/kaesar/onmind-pre/releases) in this repo and download the file for your system. Then, launch the app like this:

```bash
./onmind-pre-mac --config examples/pre_deno.yml
```

> `onmind-pre-mac` is the version for **macOS**, but it could be `onmind-pre-win` for **Windows**, even a version for **Linux**  
> `--config` is used to specify another path and file name for **YAML**

Alternatively, to run **OnMind-PRE** from sources, after clonning, launch the app like this:

```bash
deno add jsr:@david/dax
deno run --allow-read --allow-write --allow-env --allow-run main.ts --config examples/pre_deno.yml
```

> You can add the `--config` argument with the path and `yml` file with configuration.  
> To use `gum` with `valueFrom` in `variables`, install it first, e.g.: `go install github.com/charmbracelet/gum@latest`

<!--
```bash
deno compile --no-check --allow-read --allow-write --allow-env --allow-run -o onmind-pre main.ts
```
-->
