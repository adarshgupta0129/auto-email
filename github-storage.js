// github-storage.js
// Uses a GitHub repository branch as a free, always-on persistence layer for
// everything under the local `user_data/` folder (templates, saved files and the
// users.json login history).
//
// On hosts with an ephemeral filesystem (e.g. Render's free web services) the
// disk is wiped on every restart/redeploy, so files written at runtime are lost.
// This module mirrors those files to a dedicated branch on GitHub. On startup we
// pull them back down; on every change we push the changed file up.
//
// Required environment variables (persistence is disabled if any is missing):
//   GITHUB_TOKEN       - a Personal Access Token with "repo" (contents) write access
//   GITHUB_REPO        - "owner/repo", e.g. "adarshgupta/auto-email"
// Optional:
//   GITHUB_DATA_BRANCH - branch used to store data (default: "data")

const fs = require('fs');
const path = require('path');

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPO; // "owner/repo"
const BRANCH = process.env.GITHUB_DATA_BRANCH || 'data';
const API = 'https://api.github.com';
const PROJECT_ROOT = __dirname;

const enabled = Boolean(TOKEN && REPO);

if (!enabled) {
    console.warn(
        '[github-storage] Persistence disabled: set GITHUB_TOKEN and GITHUB_REPO ' +
        'to keep templates/files/logins across restarts.'
    );
}

function headers() {
    return {
        'Authorization': `Bearer ${TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'auto-email-app'
    };
}

// Convert an absolute local path into the repo-relative path (forward slashes).
function toRepoPath(absPath) {
    return path.relative(PROJECT_ROOT, absPath).split(path.sep).join('/');
}

// Make sure the data branch exists; create it from the repo's default branch if not.
async function ensureBranch() {
    let res = await fetch(`${API}/repos/${REPO}/git/ref/heads/${BRANCH}`, { headers: headers() });
    if (res.ok) return true;
    if (res.status !== 404) {
        throw new Error(`Failed to check branch ${BRANCH}: ${res.status}`);
    }

    // Branch missing - create it from the default branch head.
    const repoRes = await fetch(`${API}/repos/${REPO}`, { headers: headers() });
    if (!repoRes.ok) throw new Error(`Failed to read repo: ${repoRes.status}`);
    const defaultBranch = (await repoRes.json()).default_branch;

    const refRes = await fetch(`${API}/repos/${REPO}/git/ref/heads/${defaultBranch}`, { headers: headers() });
    if (!refRes.ok) throw new Error(`Failed to read default branch ref: ${refRes.status}`);
    const sha = (await refRes.json()).object.sha;

    const createRes = await fetch(`${API}/repos/${REPO}/git/refs`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha })
    });
    if (!createRes.ok && createRes.status !== 422) {
        // 422 == already exists (race); treat as success.
        throw new Error(`Failed to create branch ${BRANCH}: ${createRes.status}`);
    }
    return true;
}

// Serialize writes so concurrent PUTs don't clash on stale file SHAs.
let queue = Promise.resolve();

// Push a single local file up to the data branch. Fire-and-forget friendly:
// errors are logged, never thrown to the caller.
function pushFile(absPath) {
    if (!enabled) return Promise.resolve();

    const run = async () => {
        try {
            if (!fs.existsSync(absPath)) return;
            const repoPath = toRepoPath(absPath);
            const content = fs.readFileSync(absPath).toString('base64');

            // Get existing file SHA (required to update an existing file).
            let sha;
            const getRes = await fetch(
                `${API}/repos/${REPO}/contents/${encodeURIComponent(repoPath).replace(/%2F/g, '/')}?ref=${BRANCH}`,
                { headers: headers() }
            );
            if (getRes.ok) {
                sha = (await getRes.json()).sha;
            }

            const putRes = await fetch(
                `${API}/repos/${REPO}/contents/${encodeURIComponent(repoPath).replace(/%2F/g, '/')}`,
                {
                    method: 'PUT',
                    headers: headers(),
                    body: JSON.stringify({
                        message: `data: update ${repoPath}`,
                        content,
                        branch: BRANCH,
                        sha
                    })
                }
            );
            if (!putRes.ok) {
                console.error(`[github-storage] push failed for ${repoPath}: ${putRes.status} ${await putRes.text()}`);
            }
        } catch (err) {
            console.error('[github-storage] push error:', err.message);
        }
    };

    queue = queue.then(run, run);
    return queue;
}

// Delete a file from the data branch (mirrors a local unlink).
function deleteFile(absPath) {
    if (!enabled) return Promise.resolve();

    const run = async () => {
        try {
            const repoPath = toRepoPath(absPath);
            const url = `${API}/repos/${REPO}/contents/${encodeURIComponent(repoPath).replace(/%2F/g, '/')}`;
            const getRes = await fetch(`${url}?ref=${BRANCH}`, { headers: headers() });
            if (!getRes.ok) return; // nothing to delete
            const sha = (await getRes.json()).sha;

            const delRes = await fetch(url, {
                method: 'DELETE',
                headers: headers(),
                body: JSON.stringify({ message: `data: delete ${repoPath}`, branch: BRANCH, sha })
            });
            if (!delRes.ok) {
                console.error(`[github-storage] delete failed for ${repoPath}: ${delRes.status}`);
            }
        } catch (err) {
            console.error('[github-storage] delete error:', err.message);
        }
    };

    queue = queue.then(run, run);
    return queue;
}

// Pull every file under user_data/ from the data branch onto the local disk.
// Run this once at startup, before the server starts handling requests.
async function pullAll() {
    if (!enabled) return;
    try {
        await ensureBranch();

        const treeRes = await fetch(
            `${API}/repos/${REPO}/git/trees/${BRANCH}?recursive=1`,
            { headers: headers() }
        );
        if (!treeRes.ok) {
            console.error(`[github-storage] tree fetch failed: ${treeRes.status}`);
            return;
        }
        const tree = (await treeRes.json()).tree || [];
        const blobs = tree.filter(t => t.type === 'blob' && t.path.startsWith('user_data/'));

        let restored = 0;
        for (const blob of blobs) {
            const contentRes = await fetch(
                `${API}/repos/${REPO}/contents/${encodeURIComponent(blob.path).replace(/%2F/g, '/')}?ref=${BRANCH}`,
                { headers: headers() }
            );
            if (!contentRes.ok) continue;
            const data = await contentRes.json();
            const buffer = Buffer.from(data.content, 'base64');

            const absPath = path.join(PROJECT_ROOT, blob.path);
            fs.mkdirSync(path.dirname(absPath), { recursive: true });
            fs.writeFileSync(absPath, buffer);
            restored++;
        }
        console.log(`[github-storage] restored ${restored} file(s) from branch "${BRANCH}".`);
    } catch (err) {
        console.error('[github-storage] pull error:', err.message);
    }
}

module.exports = { enabled, pullAll, pushFile, deleteFile };
