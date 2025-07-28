const fs = require('fs')
const { execSync } = require('child_process')
const readline = require('readline')
const path = require('path')

// Define constants
const NODE_VERSION = '22'
const DOCKER_IMAGE_TAG = '22'
const GITHUB_ACTIONS_DIR = './.github/workflows/'
const DOCKERFILE_DIR = './'
const IGNORED_FOLDERS = ['node_modules', '.git', '.cache', 'dist', 'build'] // Folders to ignore

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
})

// Color codes
const COLORS = {
  SUCCESS: '\x1b[32m',
  ERROR: '\x1b[31m',
  INFO: '\x1b[34m',
  RESET: '\x1b[0m',
}

// Helper functions
function printSuccess(message) {
  console.log(`${COLORS.SUCCESS}${message}${COLORS.RESET}`)
}

function printError(message) {
  console.error(`${COLORS.ERROR}${message}${COLORS.RESET}`)
}

function printInfo(message) {
  console.log(`${COLORS.INFO}${message}${COLORS.RESET}`)
}

function runCommand(command) {
  try {
    execSync(command, { stdio: 'inherit' })
  } catch (error) {
    printError(`Command failed: ${command}`)
    process.exit(1)
  }
}

// Step 1: Verify Node.js version compatibility
function verifyNodeCompatibility() {
  const currentNodeVersion = process.version
  const currentMajorVersion = parseInt(currentNodeVersion.split('.')[0].replace('v', ''), 10)

  if (currentMajorVersion < parseInt(NODE_VERSION, 10)) {
    printError(`Error: Node.js version is too low. Expected version >=${NODE_VERSION}, but found ${currentNodeVersion}.`)
    process.exit(1)
  } else {
    printInfo(`Node.js version ${currentNodeVersion} is compatible.`)
  }
}

// Step 2: Update Node.js version in package.json
function updateNodeVersionInPackageJson() {
  const packageJsonPath = './package.json'
  if (!fs.existsSync(packageJsonPath)) {
    printError('package.json not found.')
    return
  }

  const packageData = require(packageJsonPath)

  if (!packageData.engines) {
    packageData.engines = {}
  }

  packageData.engines.node = `>=${NODE_VERSION}`

  fs.writeFileSync(packageJsonPath, JSON.stringify(packageData, null, 2))
  printSuccess(`Node.js version updated to >=${NODE_VERSION} in package.json`)
}

// Step 3: Update Node.js version in GitHub Actions workflows
function updateNodeVersionInGitHubActions() {
  const workflowFiles = getYamlFilesInDir(GITHUB_ACTIONS_DIR)

  if (workflowFiles.length === 0) {
    printInfo('No GitHub Actions YAML files found. Skipping update.')
    return
  }

  workflowFiles.forEach((workflowFile) => {
    printInfo(`Checking workflow file: ${workflowFile}`)
    const workflowYaml = fs.readFileSync(workflowFile, 'utf8')

    const updatedWorkflowYaml = workflowYaml.replace(/node_version:\s*\[20\]/g, `node_version: [${NODE_VERSION}]`)

    if (updatedWorkflowYaml !== workflowYaml) {
      fs.writeFileSync(workflowFile, updatedWorkflowYaml)
      printSuccess(`Node.js version updated to ${NODE_VERSION} in ${workflowFile}`)
    } else {
      printInfo(`No 'node_version' change required in ${workflowFile}.`)
    }
  })
}

// Step 3.5: Check and update @types/node
function updateTypesNode() {
  printInfo('Checking @types/node installation...')
  try {
    const packageJson = JSON.parse(fs.readFileSync('./package.json', 'utf8'))
    if (packageJson.devDependencies && packageJson.devDependencies['@types/node']) {
      printInfo(`@types/node is installed. Current version: ${packageJson.devDependencies['@types/node']}`)
      printInfo(`Updating @types/node to version ${NODE_VERSION}...`)
      runCommand(`npm install --save-dev @types/node@${NODE_VERSION}`)
      printSuccess(`@types/node updated to version ${NODE_VERSION}.`)
    } else {
      printInfo('@types/node is not installed. Skipping update.')
    }
  } catch (error) {
    printError('Failed to check or update @types/node.')
  }
}

// Step 4: Install dependencies
function installDependencies() {
  printInfo('Installing dependencies...')
  runCommand('npm install')
}

// Step 5: Prompt for @rplan update
function promptUpdateRplan() {
  return new Promise((resolve) => {
    rl.question('Do you want to update the @rplan dependency using ncu? (yes/no): ', (answer) => {
      resolve(answer.toLowerCase() === 'yes')
    })
  })
}

// Step 6: Update @rplan dependency
async function updateRplanDependency() {
  if (await promptUpdateRplan()) {
    printInfo('Updating @rplan dependency...')
    runCommand("npx npm-check-updates '/@rplan/' -u")
    runCommand('npm install')
    printSuccess('@rplan dependency updated successfully!')
  } else {
    printInfo('Skipping @rplan dependency update.')
  }
}

// Step 7: Update Dockerfiles
function checkAndUpdateDockerfiles() {
  const dockerfiles = findDockerfiles(DOCKERFILE_DIR)

  if (dockerfiles.length === 0) {
    printInfo('No Dockerfiles found in the project.')
    return
  }

  dockerfiles.forEach((dockerfile) => {
    printInfo(`Checking Dockerfile: ${dockerfile}`)
    const dockerfileContent = fs.readFileSync(dockerfile, 'utf8')

    // Replace `node:20-*` (e.g., node:20-bullseye) with base image
    let updatedContent = dockerfileContent.replace(/node:20(-[\w]*)?/g, `europe-west3-docker.pkg.dev/allex-artifacts/allex-artifacts-docker/allex-nodejs-base:${DOCKER_IMAGE_TAG}`)

    // Replace `europe-west3-docker.pkg.dev/allex-artifacts/allex-artifacts-docker/allex-nodejs-base:20-*` with newer version
    updatedContent = updatedContent.replace(/europe-west3-docker.pkg.dev\/allex-artifacts\/allex-artifacts-docker\/allex-nodejs-base:20(-[\w]*)?/g, `europe-west3-docker.pkg.dev/allex-artifacts/allex-artifacts-docker/allex-nodejs-base:${DOCKER_IMAGE_TAG}`)

    if (updatedContent !== dockerfileContent) {
      fs.writeFileSync(dockerfile, updatedContent)
      printSuccess(`Updated Node.js image in ${dockerfile} to ${DOCKER_IMAGE_TAG}`)
    } else {
      printInfo(`No changes needed in ${dockerfile}.`)
    }
  })

  rl.question(`${COLORS.INFO}Please check the Dockerfiles to verify the updates. Have you done that? (yes/no): ${COLORS.RESET}`, (answer) => {
    if (answer.toLowerCase() === 'yes') {
      printSuccess('Dockerfiles checked and updated successfully.')
    } else {
      printError('Please verify the Dockerfiles manually.')
    }
  })
}

// Utility function to find Dockerfiles, ignoring specified folders
function findDockerfiles(dir) {
  let dockerfiles = []
  const items = fs.readdirSync(dir)

  items.forEach((item) => {
    const fullPath = path.join(dir, item)
    const stat = fs.lstatSync(fullPath)

    if (stat.isDirectory()) {
      if (IGNORED_FOLDERS.includes(item)) return
      dockerfiles = dockerfiles.concat(findDockerfiles(fullPath))
    } else if (item.toLowerCase() === 'dockerfile') {
      dockerfiles.push(fullPath)
    }
  })

  return dockerfiles
}

// Utility function to get YAML files, ignoring specified folders
function getYamlFilesInDir(dir) {
  let yamlFiles = []
  const items = fs.readdirSync(dir)

  items.forEach((item) => {
    const fullPath = path.join(dir, item)
    const stat = fs.lstatSync(fullPath)

    if (stat.isDirectory()) {
      if (IGNORED_FOLDERS.includes(item)) return
      yamlFiles = yamlFiles.concat(getYamlFilesInDir(fullPath))
    } else if (fullPath.toLowerCase().endsWith('.yml') || fullPath.toLowerCase().endsWith('.yaml')) {
      yamlFiles.push(fullPath)
    }
  })

  return yamlFiles
}

// Execute migration
async function runMigration() {
  verifyNodeCompatibility()
  updateNodeVersionInPackageJson()
  updateNodeVersionInGitHubActions()
  updateTypesNode()
  installDependencies()

  await updateRplanDependency()
  checkAndUpdateDockerfiles()
  printSuccess(`Migration to Node.js ${NODE_VERSION} completed successfully!`)
  rl.close()
}

// Run the migration
runMigration()