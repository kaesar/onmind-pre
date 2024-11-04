import $ from "@david/dax";
import { exists, ensureDir } from "https://deno.land/std@0.114.0/fs/mod.ts";

interface Params {
  bucket_name: string;
  project_name: string;
  aws_region: string;
  git_repo: string;
}

async function loadParameters(): Promise<Params> {
  const configPath = "./_pre.json";
  if (!(await exists(configPath))) {
    console.error("Error: No se encontró el archivo cookiecutter.json");
    Deno.exit(1);
  }
  
  // Leer y parsear el archivo JSON
  const configText = await Deno.readTextFile(configPath);
  return JSON.parse(configText) as Params;
}

async function main() {
  // Cargar parámetros desde el archivo JSON
  const { bucket_name, project_name, aws_region, git_repo } = await loadParameters();

  if (!git_repo.endsWith(".git")) {
    console.error("El repositorio debe terminar con .git");
    Deno.exit(1);
  }

  const repoName = git_repo.split("/").pop()?.replace(".git", "") || "cloned_repo";
  const clonePath = `./${repoName}`;

  // Clonar el repositorio
  if (await exists(clonePath)) {
    console.log(`El repositorio ${repoName} ya existe en ${clonePath}. Omitiendo clonación.`);
  } else {
    console.log(`Clonando ${git_repo} en ${clonePath}...`);
    await $`git clone ${git_repo} ${clonePath}`;
    console.log("Repositorio clonado con éxito.");
  }

  // Moverse al directorio del repositorio clonado
  $.cd(clonePath);

  // Ruta a la plantilla de CloudFormation
  const templatePath = `./templates/s3_bucket.yaml`;
  const template = await Deno.readTextFile(templatePath);

  // Reemplazar las variables en la plantilla con los parámetros JSON
  const output = template
    .replace("${name}", name)
    .replace("${bucketName}", bucket_name)
    .replace("${projectName}", project_name)
    .replace("${awsRegion}", aws_region);

  // Guardar el archivo generado en el directorio de salida
  const outputPath = `${clonePath}/output/s3_bucket.yaml`;
  await ensureDir(`${clonePath}/output`);
  await Deno.writeTextFile(outputPath, output);

  console.log(`Archivo de CloudFormation generado en: ${outputPath}`);
}

main();
