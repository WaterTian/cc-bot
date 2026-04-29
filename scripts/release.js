#!/usr/bin/env node
// cc-bot release helper — atomic version bump + changelog + commit + tag.
//
// Usage:
//   node scripts/release.js patch              # 0.1.1 → 0.1.2
//   node scripts/release.js minor              # 0.1.1 → 0.2.0
//   node scripts/release.js major              # 0.1.1 → 1.0.0
//   node scripts/release.js 0.1.5              # explicit version
//
// Flags:
//   --dry         preview changes, write nothing
//   --push        after commit + tag, push main + tag to origin
//   --release     after push, also create a GitHub Release via `gh release create`
//                 (implies --push; reads CHANGELOG entry as release notes; needs `gh` CLI)
//   --no-commit   write files only, don't git add / commit / tag
//
// Safety:
//   - refuses if not on main
//   - refuses if working tree dirty
//   - refuses if tag v<new> already exists
//
// Zero runtime deps — plain Node + git.

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const FILES = {
  plugin: path.join(ROOT, '.claude-plugin/plugin.json'),
  marketplace: path.join(ROOT, '.claude-plugin/marketplace.json'),
  pkg: path.join(ROOT, 'package.json'),
  changelog: path.join(ROOT, 'CHANGELOG.md'),
}

function die(msg) {
  console.error(`❌ ${msg}`)
  process.exit(1)
}

function log(msg) { console.log(msg) }

function run(cmd, opts = {}) {
  return execSync(cmd, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  }).toString().trim()
}

function runInherit(cmd) {
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' })
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')) }
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n') }

function parseArgs() {
  const argv = process.argv.slice(2)
  const flags = { dry: false, push: false, release: false, commit: true }
  const positional = []
  for (const a of argv) {
    if (a === '--dry') flags.dry = true
    else if (a === '--push') flags.push = true
    else if (a === '--release') { flags.release = true; flags.push = true }  // --release 隐含 --push
    else if (a === '--no-commit') flags.commit = false
    else if (a.startsWith('--')) die(`unknown flag: ${a}`)
    else positional.push(a)
  }
  if (positional.length !== 1) {
    die('usage: node scripts/release.js <patch|minor|major|X.Y.Z> [--dry] [--push] [--release] [--no-commit]')
  }
  return { bump: positional[0], flags }
}

function bumpVersion(current, bump) {
  if (/^\d+\.\d+\.\d+$/.test(bump)) return bump
  const [maj, min, pat] = current.split('.').map(Number)
  if (bump === 'patch') return `${maj}.${min}.${pat + 1}`
  if (bump === 'minor') return `${maj}.${min + 1}.0`
  if (bump === 'major') return `${maj + 1}.0.0`
  die(`unknown bump: ${bump} (expect patch|minor|major|X.Y.Z)`)
}

function preflight() {
  const branch = run('git rev-parse --abbrev-ref HEAD')
  if (branch !== 'main') die(`not on main (current: ${branch})`)
  const dirty = run('git status --porcelain')
  if (dirty) die(`working tree dirty:\n${dirty}\n\n先 commit 或 stash 再跑 release.js`)
  try { run('git fetch --tags --quiet') } catch {}
}

function gatherCommitsSince(currentVersion) {
  // list commit subjects since previous tag; fallback to last 10 if tag missing
  const tag = `v${currentVersion}`
  try {
    run(`git rev-parse --verify refs/tags/${tag}`)
    return run(`git log ${tag}..HEAD --pretty=format:%s`)
      .split('\n').filter(Boolean)
  } catch {
    return run('git log -10 --pretty=format:%s').split('\n').filter(Boolean)
  }
}

function buildChangelogEntry(nextVersion, commits) {
  const today = new Date().toISOString().slice(0, 10)
  const bullets = commits.length ? commits.map(s => `- ${s}`).join('\n') : '- no commits since last tag'
  return `## [${nextVersion}] - ${today}\n\n${bullets}\n\n`
}

function prependChangelog(nextVersion, entry) {
  let existing = ''
  try { existing = fs.readFileSync(FILES.changelog, 'utf8') } catch {}
  if (existing && existing.startsWith('# Changelog')) {
    const firstReleaseIdx = existing.indexOf('\n## [')
    if (firstReleaseIdx > 0) {
      return existing.slice(0, firstReleaseIdx + 1) + entry + existing.slice(firstReleaseIdx + 1)
    }
    return existing + '\n' + entry
  }
  const header = '# Changelog\n\nAll notable changes to **cc-bot** are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).\n\n'
  return header + entry + (existing ? existing : '')
}

function main() {
  const { bump, flags } = parseArgs()
  const plugin = readJson(FILES.plugin)
  const current = plugin.version
  const next = bumpVersion(current, bump)
  if (next === current) die(`new version equals current (${current})`)

  log(`cc-bot release: ${current} → ${next}`)
  log(flags.dry ? '(dry run)' : '')

  if (!flags.dry) preflight()

  // tag existence check
  let tagExists = ''
  try { tagExists = run(`git tag --list v${next}`) } catch {}
  if (tagExists) die(`tag v${next} already exists`)

  // 1. update 3 json files
  const mkt = readJson(FILES.marketplace)
  const pkg = readJson(FILES.pkg)
  plugin.version = next
  mkt.metadata.version = next
  pkg.version = next

  // 2. gather commits + build changelog entry
  const commits = gatherCommitsSince(current)
  const entry = buildChangelogEntry(next, commits)
  const newChangelog = prependChangelog(next, entry)

  log('\nfiles to update:')
  log(`  ${path.relative(ROOT, FILES.plugin)}       version → ${next}`)
  log(`  ${path.relative(ROOT, FILES.marketplace)}  metadata.version → ${next}`)
  log(`  ${path.relative(ROOT, FILES.pkg)}                 version → ${next}`)
  log(`  ${path.relative(ROOT, FILES.changelog)}           prepend [${next}] entry (${commits.length} commits)\n`)
  log(`changelog entry:\n---\n${entry.trim()}\n---`)

  if (flags.dry) {
    log('\n(dry) no files written. re-run without --dry to apply.')
    return
  }

  writeJson(FILES.plugin, plugin)
  writeJson(FILES.marketplace, mkt)
  writeJson(FILES.pkg, pkg)
  fs.writeFileSync(FILES.changelog, newChangelog)
  log('✓ files written')

  if (!flags.commit) {
    log('\n--no-commit: skipped git add / commit / tag')
    log(`next: git add ... && git commit -m "chore: release v${next}" && git tag v${next}`)
    return
  }

  runInherit(`git add .claude-plugin/plugin.json .claude-plugin/marketplace.json package.json CHANGELOG.md`)

  const tmp = path.join(ROOT, '.release-msg.tmp')
  const msgBody = commits.length ? commits.map(s => `- ${s}`).join('\n') : '(no commits since last tag)'
  fs.writeFileSync(tmp, `chore: release v${next}\n\n${msgBody}\n`)
  try {
    runInherit(`git commit -F "${tmp}"`)
  } finally {
    try { fs.unlinkSync(tmp) } catch {}
  }

  runInherit(`git tag v${next}`)
  log(`✓ committed + tagged v${next}`)

  if (flags.push) {
    runInherit('git push origin main')
    runInherit(`git push origin v${next}`)
    log(`✓ pushed main + v${next} to origin`)
  } else {
    log('')
    log('Not pushed. To publish:')
    log(`  git push origin main && git push origin v${next}`)
  }

  if (flags.release) {
    // 检测 gh CLI
    let ghOk = false
    try { run('gh --version'); ghOk = true } catch {}
    if (!ghOk) {
      log('')
      log('⚠ gh CLI 未安装/不可用，跳过 GitHub Release 创建。手工补：')
      log(`  gh release create v${next} --title "v${next}" --notes "<paste CHANGELOG entry>"`)
      return
    }
    // 把刚 prepend 的 entry 作为 release notes
    const tmp = path.join(ROOT, '.release-notes.tmp')
    fs.writeFileSync(tmp, entry.trim() + '\n')
    try {
      const url = run(`gh release create v${next} --title "v${next}" --notes-file "${tmp}"`)
      log(`✓ GitHub Release created: ${url}`)
    } catch (err) {
      log('')
      log(`⚠ gh release create 失败：${err.message}`)
      log(`手工补：gh release create v${next} --title "v${next}" --notes-file CHANGELOG.md`)
    } finally {
      try { fs.unlinkSync(tmp) } catch {}
    }
  } else if (flags.push) {
    log('')
    log('GitHub Release 未创建。要建：')
    log(`  gh release create v${next} --title "v${next}" --notes-file CHANGELOG.md`)
    log('或下次直接用 --release（隐含 --push + 建 release 一把梭）。')
  }
}

main()
