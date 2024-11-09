# OnMind-PRE

**Predefined Rutinme Environment (PRE)**. A way to prepare and make progressive development, such as scaffolding or local deploy, using **YAML** and linking **Bash** commands in a blueprint. It is a simple **CI/CD** tool also (in its foundations) but starts before of that.

To use **OnMind-PRE**, first set a `_pre.yml` with the following specification example (is similar to basic aspects of **Azure Pipelines**):

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

To run **OnMind-PRE** from sources (after clonning), launch the app like this:

```bash
deno add jsr:@david/dax
deno run --allow-read --allow-write --allow-env --allow-run main.ts
```

> You can add the `--config` argument with the path and `yml` file with configuration.  
> To use `gum` with `valueFrom` in `variables`, install it first, e.g.: `go install github.com/charmbracelet/gum@latest`

<!--
```bash
deno compile --allow-read --allow-write --allow-env --allow-run -o onmind-pre main.ts
```
-->
