import $ from "@david/dax";
import { exists, ensureDir } from "https://deno.land/std@0.114.0/fs/mod.ts";
import { parse as parseYaml } from "https://deno.land/std@0.182.0/yaml/mod.ts";
import { parse } from "https://deno.land/std@0.182.0/flags/mod.ts";
// import { parseFlags } from "@cliffy/flags";

interface Variable {
  name: string;
  value?: string;
  valueFrom?: string;
}

interface Step {
  bash: string;
  displayName?: string;
  parallel?: boolean;
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
  const continueOnError = !!args["continue-on-error"];
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
  if (!config.variables || !Array.isArray(config.variables)) {
    logError("El archivo YAML debe contener una lista 'variables'.");
    Deno.exit(1);
  }
  if (!config.steps || !Array.isArray(config.steps)) {
    logError("El archivo YAML debe contener una lista 'steps'.");
    Deno.exit(1);
  }

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

function substituteVariables(command: string, params: Params): string {
  // Ordenar por longitud descendente para evitar solapamientos (name2 antes que name)
  const keys = Object.keys(params).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    command = command.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), params[key]);
  }
  return command;
}

async function executeSteps(steps: Step[], params: Params) {
  // Agrupar pasos paralelos y secuenciales
  let i = 0;
  while (i < steps.length) {
    if (steps[i].parallel) {
      // Ejecutar todos los pasos consecutivos con parallel: true
      const parallelGroup = [];
      while (i < steps.length && steps[i].parallel) {
        parallelGroup.push(steps[i]);
        i++;
      }
      await Promise.all(parallelGroup.map(async (step) => {
        await runStep(step, params);
      }));
    } else {
      await runStep(steps[i], params);
      i++;
    }
  }
  logSuccess(":: [ Prepared sentences completed successfully ] ::")
}

async function runStep(step: Step, params: Params) {
  if (step.displayName) {
    logInfo(`\n:: [ ${step.displayName} ] ::`);
  }
  let command = substituteVariables(step.bash, params);
  try {
    logWarning(`=> ${command}`);
    const result = await $.raw`${command}`.text();
    logSuccess(` √ ${result}`);
  } catch (error: unknown) {
    logError(`\n * Error executing: ${command}\n`);
    if (!continueOnError) {
      Deno.exit(1);
    }
  }
}

async function main() {
  const { params, steps } = await loadParameters();
  console.log(`\n=> Loaded parameters:`, params);
  await executeSteps(steps, params);
}
/*
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
*/
main();
