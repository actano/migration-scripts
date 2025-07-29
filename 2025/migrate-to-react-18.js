#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const readline = require('readline')

// === Version config ===
const TARGET_VERSIONS = {
  react: '^18.3.1',
  'react-dom': '^18.3.1',
  '@testing-library/react': '^14.0.0',
  'react-test-renderer': '^18.3.1',
}

// === Terminal colors ===
const color = {
  blue: text => `\x1b[34m${text}\x1b[0m`,
  green: text => `\x1b[32m${text}\x1b[0m`,
  yellow: text => `\x1b[33m${text}\x1b[0m`,
  red: text => `\x1b[31m${text}\x1b[0m`,
}

const log = {
  info: msg => console.log(color.blue(`ℹ️  ${msg}`)),
  success: msg => console.log(color.green(`✅  ${msg}`)),
  warn: msg => console.log(color.yellow(`⚠️  ${msg}`)),
  error: msg => console.error(color.red(`❌  ${msg}`)),
}

// Ignore warnings for these packages if explicitly set to React 18 compatible version
const ignoreWarningsFor = ['react-test-renderer']

function ensureNCU() {
  log.info('Checking if ncu (npm-check-updates) is installed...')
  try {
    execSync('ncu -v', { stdio: 'ignore' })
    log.success('ncu is installed.')
  } catch {
    log.warn('ncu not found. Installing globally...')
    try {
      execSync('npm install -g npm-check-updates', { stdio: 'inherit' })
      log.success('ncu installed globally.')
    } catch {
      log.error('Failed to install npm-check-updates globally.')
      process.exit(1)
    }
  }
}

function loadPackageJson() {
  const file = path.resolve(process.cwd(), 'package.json')
  if (!fs.existsSync(file)) {
    log.error('package.json not found in current directory.')
    process.exit(1)
  }
  return {
    file,
    data: JSON.parse(fs.readFileSync(file, 'utf8')),
  }
}

function savePackageJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  log.success('package.json updated.')
}

function updateDeps(deps, name, version) {
  if (deps && deps[name]) {
    deps[name] = version
    log.info(`Updated ${name} → ${version}`)
  }
}

function updateRplanDepsWithNCU() {
  log.info('Updating @rplan/* dependencies using ncu...')
  try {
    execSync('ncu "/@rplan\\/.*/" -u', { stdio: 'inherit' })
    log.success('@rplan/* dependencies updated to latest.')
  } catch {
    log.error('Failed to update @rplan/* dependencies using ncu.')
  }
}

function updateCoreReactDeps() {
  const { file, data: pkg } = loadPackageJson()
  for (const [name, version] of Object.entries(TARGET_VERSIONS)) {
    updateDeps(pkg.dependencies, name, version)
    updateDeps(pkg.devDependencies, name, version)
    updateDeps(pkg.peerDependencies, name, version)
  }
  savePackageJson(file, pkg)
}

function syncRplanPeerDepsToInstalled() {
  const { file, data: pkg } = loadPackageJson()
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
  pkg.peerDependencies = pkg.peerDependencies || {}
  Object.keys(allDeps).forEach((dep) => {
    if (dep.startsWith('@rplan/') && pkg.peerDependencies[dep]) {
      pkg.peerDependencies[dep] = allDeps[dep]
      log.info(`Synced peerDependency ${dep} → ${allDeps[dep]}`)
    }
  })
  savePackageJson(file, pkg)
}

async function checkRplanPeerDepsForReact17Prompt() {
  const pkg = loadPackageJson().data
  const rplanDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    .filter(name => name.startsWith('@rplan/'))
  const issues = []
  for (const dep of rplanDeps) {
    try {
      const depPath = path.join('node_modules', dep, 'package.json')
      if (!fs.existsSync(depPath)) continue
      const depPkg = JSON.parse(fs.readFileSync(depPath, 'utf8'))
      const peer = depPkg.peerDependencies || {}
      for (const key of ['react', 'react-dom']) {
        if (peer[key]) {
          if (/17\./.test(peer[key]) && !/18/.test(peer[key])) {
            issues.push({
              name: dep,
              peer: key,
              required: peer[key],
            })
          }
        }
      }
    } catch {
      log.warn(`Could not check peerDependencies for ${dep}`)
    }
  }
  if (issues.length > 0) {
    log.warn('Some @rplan/* packages still require React 17 and may cause peer dependency issues:')
    issues.forEach(({ name, peer, required }) => {
      log.warn(`  ${name}: peerDependency ${peer}@${required}`)
    })
    const cont = await promptContinue()
    if (!cont) {
      log.error('Aborting migration due to incompatible @rplan/* peer dependencies.')
      process.exit(1)
    } else {
      log.warn('Proceeding with forced install despite @rplan/* peer dependency issues.')
    }
  } else {
    log.success('All @rplan/* packages support React 18 in their peerDependencies.')
  }
}

async function checkNonRplanPeerDepsForReact17Prompt() {
  const pkg = loadPackageJson().data
  const core = ['react', 'react-dom', '@testing-library/react']
  const allDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    .filter(name => !name.startsWith('@rplan/') && !core.includes(name))
  const issues = []
  for (const dep of allDeps) {
    // Skip if in ignore list and version is >= 18
    if (
      ignoreWarningsFor.includes(dep)
      && (
        (pkg.dependencies && pkg.dependencies[dep] && /^18\./.test(pkg.dependencies[dep]))
        || (pkg.devDependencies && pkg.devDependencies[dep] && /^18\./.test(pkg.devDependencies[dep]))
      )
    ) {
      continue
    }
    try {
      const depPath = path.join('node_modules', dep, 'package.json')
      if (!fs.existsSync(depPath)) continue
      const depPkg = JSON.parse(fs.readFileSync(depPath, 'utf8'))
      const peer = depPkg.peerDependencies || {}
      for (const key of core) {
        if (peer[key]) {
          if (/17\./.test(peer[key]) && !/18/.test(peer[key])) {
            issues.push({
              name: dep,
              peer: key,
              required: peer[key],
            })
          }
        }
      }
    } catch {
      log.warn(`Could not check peerDependencies for ${dep}`)
    }
  }
  if (issues.length > 0) {
    log.warn('The following package(s) need to be updated to a version that supports React 18. Please upgrade them in the next step to ensure compatibility.')
    issues.forEach(({ name, peer, required }) => {
      log.warn(`  ${name}: peerDependency ${peer}@${required}`)
    })
    const cont = await promptContinue()
    if (!cont) {
      log.error('Aborting migration due to incompatible peer dependencies.')
      process.exit(1)
    } else {
      log.warn('Proceeding with forced install despite peer dependency issues.')
    }
  } else {
    log.success('All non-@rplan dependencies support React 18 in their peerDependencies.')
  }
}

function printMigrationSuccess() {
  log.success('🎉 React 18 migration complete. All core and checked dependencies are now compatible or force-installed.')
  const msg = 'No commit will be made by this script. Please review the changes and commit them manually.'
  const line = '─'.repeat(msg.length + 2)
  console.log(color.green(`\n┌${line}┐`))
  console.log(color.green(`│ ${msg} │`))
  console.log(color.green(`└${line}┘`))
}

async function promptContinue() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(
      color.red('NOTE: This project is not ready for React 18 until all leaf dependencies (the lowest-level packages in your dependency tree) are updated to support React 18. Please work on above library before.\n')
      + color.yellow('Some packages may not support React 18.3.1. Continue migration? (y/N): '),
      (answer) => {
        rl.close()
        resolve(/^y(es)?$/i.test(answer.trim()))
      },
    )
  })
}

function stepBox(title) {
  const line = '─'.repeat(title.length + 2)
  console.log(`\n${color.blue(`┌${line}┐`)}`)
  console.log(color.blue(`│ ${title} │`))
  console.log(color.blue(`└${line}┘`))
}

// === MAIN ===
async function migrate() {
  stepBox('Starting React migration script')
  log.info('🔁 Starting React migration script...')
  stepBox('Check ncu (npm-check-updates)')
  ensureNCU()
  stepBox('Update core React dependencies')
  updateCoreReactDeps()
  stepBox('Update @rplan/* dependencies')
  updateRplanDepsWithNCU()
  stepBox('Sync @rplan/* peerDependencies to installed versions')
  syncRplanPeerDepsToInstalled()
  stepBox('Check @rplan/* peerDependencies for React 17')
  await checkRplanPeerDepsForReact17Prompt()
  stepBox('Check non-@rplan peerDependencies for React 17')
  await checkNonRplanPeerDepsForReact17Prompt()
  stepBox('Install dependencies (npm install)')
  log.info('Running npm install...')
  try {
    execSync('npm install', { stdio: 'inherit' })
    stepBox('Migration Complete')
    printMigrationSuccess()
  } catch {
    log.error('npm install failed.')
    process.exit(1)
  }
}

(async () => {
  await migrate()
})()