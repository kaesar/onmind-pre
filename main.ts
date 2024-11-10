import $ from "@david/dax";
import { exists, ensureDir } from "https://deno.land/std@0.114.0/fs/mod.ts";
import { parse as parseYaml } from "https://deno.land/std@0.182.0/yaml/mod.ts";
import { parse } from "https://deno.land/std@0.182.0/flags/mod.ts";

interface Variable {
  name: string;
  value?: string;
  valueFrom?: string;
}

interface Step {
  bash: string;
  displayName?: string;
}

interface Config {
  variables: Variable[];
  steps: Step[];
}

interface Params {
  [key: string]: string;
}

interface ConfigResult {
  params: Params;
  steps: Step[];
}

const colors = {
  red: '\x1b[38;2;255;20;60m',    // errors
  yellow: '\x1b[33m',             // warnings
  green: '\x1b[32m',              // success
  blue: '\x1b[38;2;0;157;255m',   // info
  reset: '\x1b[0m'
};

function logError(message: string) {
  console.error(`${colors.red}${message}${colors.reset}`);
}

function logWarning(message: string) {
  console.warn(`${colors.yellow}${message}${colors.reset}`);
}

function logSuccess(message: string) {
  console.log(`${colors.green}${message}${colors.reset}`);
}

function logInfo(message: string) {
  console.log(`${colors.blue}${message}${colors.reset}`);
}

let hasValueFrom = false;

async function loadParameters(): Promise<ConfigResult> {
  let configPath: string | undefined;
  
  // 1. Check if config is provided as an argument
  const args = parse(Deno.args);
  if (args.config) {
    configPath = args.config;
    if (await exists(configPath)) {
      console.log(`Using configuration from argument: ${configPath}`);
    } else {
      logError(`Error: Configuration file specified in arguments not found: ${configPath}`);
      Deno.exit(1);
    }
  }
  
  // 2. Check ./_pre.yml if no argument provided
  if (!configPath && await exists("./_pre.yml")) {
    configPath = "./_pre.yml";
    console.log("Using configuration from ./_pre.yml");
  }
  
  // 3. Check ./pre/_pre.yml if previous locations not found
  if (!configPath && await exists("./pre/_pre.yml")) {
    configPath = "./pre/_pre.yml";
    console.log("Using configuration from ./pre/_pre.yml");
  }
  
  // 4. Error if no configuration file found
  if (!configPath) {
    logWarning("Error: No configuration file found. Please provide one of the following:");
    logWarning("- Use --config argument to specify the configuration file");
    logWarning("- Place _pre.yml in the current directory");
    logWarning("- Place _pre.yml in the ./pre directory");
    Deno.exit(1);
  }
  
  const configText = await Deno.readTextFile(configPath);
  const config = parseYaml(configText) as Config;

  const params: Params = {};
  await Promise.all(
    config.variables?.map(async (variable: Variable) => {
      if (variable.value !== undefined) {
        params[variable.name] = variable.value;
      } else if (variable.valueFrom !== undefined) {  // valueRead
        const result = await $.raw`${variable.valueFrom}`.text();
        params[variable.name] = result;
        hasValueFrom = true;
      }
    }) || []
  );

  return { params, steps: config.steps };
}

async function executeSteps(steps: Step[], params: Params) {
  let result;
  for (const step of steps) {
    if (step.displayName) {
      logInfo(`\n:: [ ${step.displayName} ] ::`);
    }

    // Replace variables in the bash command
    let command = step.bash;
    for (const [key, value] of Object.entries(params)) {
      command = command.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), value);
    }

    try {
      logWarning(`=> ${command}`);
      result = await $.raw`${command}`.text();
      // if (!hasValueFrom) {
      //   result = await $.raw`${command}`.text();
      // } else {
      //   result = await $.raw`gum spin --spinner dot --title "${step.displayName}..." --show-output --timeout=0 -- ${command}`.text();
      // }
      logSuccess(` √ ${result}`);
    } catch (error: unknown) {
      logError(`\n * Error executing: ${command}\n`);
      //logError(error.message || error);
      Deno.exit(1);
    }
  }

  logSuccess(":: [ Prepared sentences completed successfully ] ::")
}

async function main() {
  const { params, steps } = await loadParameters();
  console.log(`\n=> Loaded parameters:`, params);
  await executeSteps(steps, params);
}

async function checkoutTask() {
  const { bucket_name, project_name, aws_region, git_repo } = await loadParameters();

  if (!git_repo.endsWith(".git")) {
    console.error("El repositorio debe terminar con .git");
    Deno.exit(1);
  }

  const repoName = git_repo.split("/").pop()?.replace(".git", "") || "cloned_repo";
  const clonePath = `./${repoName}`;

  if (await exists(clonePath)) {
    console.log(`El repositorio ${repoName} ya existe en ${clonePath}. Omitiendo clonación.`);
  } else {
    console.log(`Clonando ${git_repo} en ${clonePath}...`);
    await $`git clone ${git_repo} ${clonePath}`;
    console.log("Repositorio clonado con éxito.");
  }

  $.cd(clonePath);

  const templatePath = `./templates/s3_bucket.yaml`;
  const template = await Deno.readTextFile(templatePath);

  const output = template
    .replace("${name}", name)
    .replace("${bucketName}", bucket_name)
    .replace("${projectName}", project_name)
    .replace("${awsRegion}", aws_region);

  const outputPath = `${clonePath}/output/s3_bucket.yaml`;
  await ensureDir(`${clonePath}/output`);
  await Deno.writeTextFile(outputPath, output);

  console.log(`CloudFormation generated in: ${outputPath}`);
}

main();
