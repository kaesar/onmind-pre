# OnMind-PRE

**Predefined Rutinme Environment (PRE)**. A way to prepare and make progressive development, such as scaffolding or local deploy, using **YAML** and linking **Bash** commands in a blueprint. It is a simple **CI/CD** tool also (in its foundations) but starts before of that.

Set a `_pre.yml` with the following specification example:

```yml
# Comment or title
variables:
- name: name
  value: there
steps:
- bash: echo "Hi ${name}"
  displayName: Hello
- bash: echo "Bye!"
```

> `${name}` is used to replace varariable (according its name) by its value

Run example:

```bash
deno add jsr:@david/dax
deno run --allow-read --allow-write --allow-run main.ts
```

<!--
```bash
deno compile --allow-read --allow-write --allow-run -o s3-generator main.ts
```
-->
