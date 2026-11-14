#!/usr/bin/env node
/**
 * Cut a release in one command: bump the version, run the checks, push the whole
 * working directory through the GitHub API, and reply to the market-index issue
 * with the new version and commit SHA.
 *
 * The market lists this bundle from a pinned commit, so every release needs that
 * reply — otherwise the entry keeps pointing at the older SHA until a maintainer
 * re-checks it.
 *
 *   node scripts/release.mjs patch            # 0.12.0 -> 0.12.1
 *   node scripts/release.mjs minor -m "…"     # 0.12.0 -> 0.13.0
 *   node scripts/release.mjs 1.0.0            # explicit version
 *   node scripts/release.mjs --announce [sha] # only reply, for a commit already pushed
 *
 * Flags: --dry-run (everything except the writes), --no-push, --no-comment,
 *        --force (push even when the remote has files this tree lacks),
 *        --issue <n> (default 492), --index-repo <owner/repo>, --repo <owner/repo>.
 *
 * Needs GH_TOKEN, or a logged-in `gh` CLI. This machine cannot reach github.com,
 * only api.github.com, which is why the push goes through the REST API.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKIP_DIRS = new Set(['node_modules', '.git', '.tmp'])
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db'])
const DEFAULT_REPO = 'wuwen1994/dsh-annotate'
const DEFAULT_INDEX_REPO = 'polang233/dsh-plugin-index'
const DEFAULT_ISSUE = 492

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const noPush = args.includes('--no-push')
const noComment = args.includes('--no-comment')
const force = args.includes('--force')
const valued = new Set(['-m', '--message', '--issue', '--repo', '--index-repo', '--announce'])
const flagValue = (name, fallback) => {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}
const messageFlag = flagValue('-m', flagValue('--message', undefined))
const issue = Number(flagValue('--issue', DEFAULT_ISSUE))
const repo = flagValue('--repo', DEFAULT_REPO)
const indexRepo = flagValue('--index-repo', DEFAULT_INDEX_REPO)
const announce = flagValue('--announce', undefined)
const bump = args.find((arg, index) => !arg.startsWith('-') && !valued.has(args[index - 1]))

function fail(text) {
  console.error(`release: ${text}`)
  process.exit(1)
}

const token = process.env.GH_TOKEN || (() => {
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
  } catch {
    fail('GH_TOKEN is not set and `gh auth token` failed')
  }
})()

async function apiFor(target, path, init = {}) {
  const response = await fetch(`https://api.github.com/repos/${target}/${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-annotate-release',
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  })
  const text = await response.text()
  if (!response.ok) fail(`${target}/${path} -> ${response.status} ${text}`)
  return text ? JSON.parse(text) : null
}
const api = (path, init) => apiFor(repo, path, init)

const packagePath = join(ROOT, 'package.json')
const packageText = readFileSync(packagePath, 'utf8')
const current = JSON.parse(packageText).version

function replyBody(version, sha, note) {
  return [
    `已发布 \`v${version}\`（\`${repo}\`）：\`${sha}\``,
    '',
    `- 安装：\`plugin_manager install_bundle\` 目标 \`github:${repo}#${sha}\``,
    `- 变更：${note || `release: v${version}`}`,
  ].join('\n')
}

async function reply(version, sha, note) {
  if (noComment) return false
  if (dryRun) {
    console.log(`release: would comment on ${indexRepo}#${issue}:\n\n${replyBody(version, sha, note)}\n`)
    return false
  }
  try {
    await apiFor(indexRepo, `issues/${issue}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: replyBody(version, sha, note) }),
    })
    return true
  } catch {
    console.error('release: the push happened but the reply did not — post it by hand:')
    console.error(`  gh issue comment ${issue} --repo ${indexRepo} --body-file <file with the text above>`)
    return false
  }
}

async function main() {
  // Announce a commit that is already on main — no bump, no push.
  if (announce !== undefined) {
    const sha = /^[0-9a-f]{40}$/i.test(announce) ? announce : (await api('git/ref/heads/main')).object.sha
    const posted = await reply(current, sha, messageFlag)
    console.log(JSON.stringify({ version: current, commit: sha, commented: posted, dryRun }, null, 2))
    return
  }

  if (!bump) {
    console.error('usage: node scripts/release.mjs <patch|minor|major|x.y.z> [-m message] [--dry-run] [--no-push] [--no-comment] [--force]')
    console.error('       node scripts/release.mjs --announce [sha]    # reply about a commit already pushed')
    return
  }

  // -------------------------------------------------------------- versioning

  function nextVersion(bump) {
    if (/^\d+\.\d+\.\d+$/.test(bump)) return bump
    const [major, minor, patch] = current.split('.').map(Number)
    if (bump === 'major') return `${major + 1}.0.0`
    if (bump === 'minor') return `${major}.${minor + 1}.0`
    if (bump === 'patch') return `${major}.${minor}.${patch + 1}`
    fail(`unknown bump "${bump}" — use patch, minor, major or an explicit x.y.z`)
  }

  const version = nextVersion(bump)
  if (version === current) fail(`version is already ${current}`)

  // ----------------------------------------------------------------- the tree

  function walk(dir, out = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out)
        continue
      }
      if (entry.isFile() && !SKIP_FILES.has(entry.name) && !entry.name.endsWith('.log')) {
        out.push(join(dir, entry.name))
      }
    }
    return out
  }

  const files = walk(ROOT)
    .map((path) => ({ path: relative(ROOT, path).split(sep).join('/'), absolute: path }))
    .sort((a, b) => a.path.localeCompare(b.path))

  const blobHash = (data) => createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex')

  // Never overwrite work that came from somewhere else: every file the remote has
  // must exist here too, unless --force says otherwise.
  const headSha = (await api('git/ref/heads/main')).object.sha
  const remoteTree = await api(`git/trees/${headSha}?recursive=1`)
  const localPaths = new Set(files.map((file) => file.path))
  const missing = remoteTree.tree
    .filter((entry) => entry.type === 'blob' && !localPaths.has(entry.path))
    .map((entry) => entry.path)
  if (missing.length > 0 && !force) {
    fail(`the remote has files this tree does not (use --force to push anyway): ${missing.join(', ')}`)
  }

  // -------------------------------------------------------------- the checks

  function run(command, commandArgs) {
    try {
      return execFileSync(command, commandArgs, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
    } catch (error) {
      fail(`${command} ${commandArgs.join(' ')} failed:\n${(error.stdout || '') + (error.stderr || '')}`)
    }
  }

  run(process.execPath, ['--check', 'client.js'])
  const testOutput = run(process.execPath, ['test/smoke.mjs'])
  const checks = /ok — (\d+) checks/.exec(testOutput)?.[1]
  if (!checks) fail(`the smoke test did not report a pass:\n${testOutput.slice(-600)}`)

  // ---------------------------------------------------------- bump and write

  if (!dryRun) {
    writeFileSync(packagePath, packageText.replace(`"version": "${current}"`, `"version": "${version}"`), 'utf8')

    // Keep the examples in the docs from advertising the previous release.
    for (const doc of ['README.md', 'docs/DETAIL.md']) {
      const path = join(ROOT, doc)
      const text = readFileSync(path, 'utf8')
      if (!text.includes(current)) continue
      writeFileSync(path, text.split(current).join(version), 'utf8')
    }

    const readmePath = join(ROOT, 'README.md')
    const readme = readFileSync(readmePath, 'utf8').replace(/ok — \d+ checks/g, `ok — ${checks} checks`)
    writeFileSync(readmePath, readme, 'utf8')
  }

  // ------------------------------------------------------------------- push

  const commitMessage = messageFlag || `release: v${version}`
  const changed = files.filter((file) => {
    const hash = blobHash(readFileSync(file.absolute))
    const remote = remoteTree.tree.find((entry) => entry.path === file.path)
    return !remote || remote.sha !== hash
  })
  console.log(`release: ${changed.length} file(s) to push`)

  let newSha = ''
  if (!noPush) {
    if (dryRun) {
      newSha = '(dry-run)'
    } else {
      const blobs = []
      for (const file of changed) {
        const data = readFileSync(file.absolute)
        const blob = await api('git/blobs', {
          method: 'POST',
          body: JSON.stringify({ content: data.toString('base64'), encoding: 'base64' }),
        })
        blobs.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha })
      }
      const tree = await api('git/trees', { method: 'POST', body: JSON.stringify({ base_tree: headSha, tree: blobs }) })
      const commit = await api('git/commits', {
        method: 'POST',
        body: JSON.stringify({ message: commitMessage, tree: tree.sha, parents: [headSha] }),
      })
      await api('git/refs/heads/main', { method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }) })
      newSha = commit.sha
    }
  } else {
    console.log('release: --no-push, nothing was written to GitHub')
  }

  // ---------------------------------------------------------------- comment

  const commented = await reply(version, newSha || '(not pushed)', commitMessage)

  // ------------------------------------------------------------------ report

  console.log(JSON.stringify({
    version,
    previous: current,
    checks: Number(checks),
    commit: newSha,
    issue: `https://github.com/${indexRepo}/issues/${issue}`,
    dryRun,
    pushed: Boolean(newSha) && !dryRun,
    commented,
  }, null, 2))

  if (!dryRun) {
    console.log('\nnext: reinstall the local bundle so the recorded version matches, then refresh the GUI')
    console.log(`      plugin_manager remove_bundle + install_bundle ${ROOT}`)
  }
}

await main()
