/**
 * WEAPON VERIFICATION SCRIPT
 * 
 * Fetches each Nikke's character page from Prydwen.gg and compares
 * the weapon type against what's in nikke-database.js.
 * 
 * Usage: node scripts/verify-weapons.js
 * 
 * Output: Prints mismatches to console and writes a report to data/weapon-mismatches.json
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// ── Load the database ───────────────────────────────────────
const dbPath = path.join(__dirname, '..', 'knowledge', 'nikke-database.js');
const dbContent = fs.readFileSync(dbPath, 'utf8');

// Extract all name/weapon/slug entries from NIKKE_DATABASE array
const entries = [];
const entryRegex = /\{\s*id:\s*(\d+),\s*name:\s*"([^"]+)"[^}]*?weapon:\s*"([^"]+)"[^}]*?(?:slug:\s*"([^"]+)"[^}]*?)?\}/gs;
let match;
while ((match = entryRegex.exec(dbContent)) !== null) {
    const id = parseInt(match[1]);
    const name = match[2];
    const weapon = match[3];
    const slug = match[4] || null;
    // Skip collection dolls (id < 1000) and non-playable entries
    if (id >= 1 && id < 100000) {
        entries.push({ id, name, weapon, slug });
    }
}

// Filter to only actual Nikke characters (not dolls/treasures - those have ids 100xxx/200xxx)
const nikkes = entries.filter(e => e.id < 1000 || e.id >= 100000);

// Actually, let's re-parse more carefully. The database has collection dolls in a separate array.
// Let's just grab everything from the NIKKE_DATABASE const that has burst fields
const nikkeEntries = [];
const nikkeBlockRegex = /\{\s*id:\s*(\d+),\s*name:\s*"([^"]+)",\s*burst1:/gs;
let blockMatch;
while ((blockMatch = nikkeBlockRegex.exec(dbContent)) !== null) {
    const startIdx = blockMatch.index;
    // Find the weapon in this block
    const blockSlice = dbContent.slice(startIdx, startIdx + 500);
    const weaponMatch = blockSlice.match(/weapon:\s*"([^"]+)"/);
    const slugMatch = blockSlice.match(/slug:\s*"([^"]+)"/);
    if (weaponMatch) {
        nikkeEntries.push({
            id: parseInt(blockMatch[1]),
            name: blockMatch[2],
            weapon: weaponMatch[1],
            slug: slugMatch ? slugMatch[1] : null
        });
    }
}

console.log(`Found ${nikkeEntries.length} Nikke entries in database`);

// ── Slug generation (mirrors the app logic) ─────────────────
function makeSlug(name, entry) {
    if (entry.slug) return entry.slug;
    return name
        .toLowerCase()
        .replace(/:/g, '')
        .replace(/\./g, '')
        .replace(/'/g, '')
        .replace(/\(/g, '')
        .replace(/\)/g, '')
        .replace(/\s+/g, '-');
}

// ── Weapon mapping from Prydwen text to our codes ───────────
const PRYDWEN_TO_CODE = {
    'assault rifle': 'AR',
    'minigun': 'MG',
    'lmg': 'MG',
    'machine gun': 'MG',
    'shotgun': 'SG',
    'smg': 'SMG',
    'submachine gun': 'SMG',
    'sniper rifle': 'SR',
    'rocket launcher': 'RL',
};

// ── Fetch a URL and return body text ────────────────────────
function fetch(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 NikkeVerifier/1.0' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                // Follow redirect
                const redirectUrl = res.headers.location.startsWith('http')
                    ? res.headers.location
                    : `https://www.prydwen.gg${res.headers.location}`;
                return fetch(redirectUrl).then(resolve).catch(reject);
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
            res.on('error', reject);
        }).on('error', reject);
    });
}

// ── Extract weapon from Prydwen page HTML ───────────────────
function extractWeapon(html) {
    // Look for pattern: "wields a <WeaponName>" in the intro text
    const patterns = [
        /wields\s+a[n]?\s+(Assault Rifle|Minigun|LMG|Machine Gun|Shotgun|SMG|Submachine Gun|Sniper Rifle|Rocket Launcher)/i,
        /weapon_(\w+)\.webp/i,  // fallback: weapon icon filename
    ];
    
    for (const pattern of patterns) {
        const m = html.match(pattern);
        if (m) {
            const weaponText = m[1].toLowerCase();
            // Handle icon filename fallback
            if (pattern === patterns[1]) {
                const iconMap = { 'ar': 'AR', 'minigun': 'MG', 'shotgun': 'SG', 'smg': 'SMG', 'sniper': 'SR', 'rocket': 'RL' };
                return iconMap[weaponText] || null;
            }
            return PRYDWEN_TO_CODE[weaponText] || null;
        }
    }
    return null;
}

// ── Main verification loop ──────────────────────────────────
async function verify() {
    const mismatches = [];
    const errors = [];
    const verified = [];
    
    // Rate limit: 500ms between requests to be polite
    const DELAY_MS = 500;
    
    for (let i = 0; i < nikkeEntries.length; i++) {
        const entry = nikkeEntries[i];
        const slug = makeSlug(entry.name, entry);
        const url = `https://www.prydwen.gg/nikke/characters/${slug}`;
        
        process.stdout.write(`[${i + 1}/${nikkeEntries.length}] Checking ${entry.name} (${slug})...`);
        
        try {
            const { status, body } = await fetch(url);
            
            if (status !== 200) {
                console.log(` HTTP ${status} - SKIPPED`);
                errors.push({ name: entry.name, slug, status, reason: `HTTP ${status}` });
                await sleep(DELAY_MS);
                continue;
            }
            
            const prydwenWeapon = extractWeapon(body);
            
            if (!prydwenWeapon) {
                console.log(` Could not parse weapon - SKIPPED`);
                errors.push({ name: entry.name, slug, status: 200, reason: 'Could not parse weapon from page' });
                await sleep(DELAY_MS);
                continue;
            }
            
            if (prydwenWeapon !== entry.weapon) {
                console.log(` MISMATCH! DB=${entry.weapon} Prydwen=${prydwenWeapon}`);
                mismatches.push({ name: entry.name, dbWeapon: entry.weapon, prydwenWeapon, slug });
            } else {
                console.log(` OK (${entry.weapon})`);
                verified.push({ name: entry.name, weapon: entry.weapon });
            }
        } catch (err) {
            console.log(` ERROR: ${err.message}`);
            errors.push({ name: entry.name, slug, reason: err.message });
        }
        
        await sleep(DELAY_MS);
    }
    
    // ── Report ──────────────────────────────────────────────
    console.log('\n' + '='.repeat(60));
    console.log('VERIFICATION COMPLETE');
    console.log('='.repeat(60));
    console.log(`Total checked: ${nikkeEntries.length}`);
    console.log(`Verified OK:   ${verified.length}`);
    console.log(`Mismatches:    ${mismatches.length}`);
    console.log(`Errors/Skipped: ${errors.length}`);
    
    if (mismatches.length) {
        console.log('\n── MISMATCHES ──────────────────────────────────────────');
        mismatches.forEach(m => {
            console.log(`  ${m.name}: DB="${m.dbWeapon}" → Prydwen="${m.prydwenWeapon}"`);
        });
    }
    
    if (errors.length) {
        console.log('\n── ERRORS (could not verify) ───────────────────────────');
        errors.forEach(e => {
            console.log(`  ${e.name} (${e.slug}): ${e.reason}`);
        });
    }
    
    // Write report to file
    const report = { timestamp: new Date().toISOString(), mismatches, errors, verified };
    const reportPath = path.join(__dirname, '..', 'data', 'weapon-mismatches.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\nReport saved to: ${reportPath}`);
    
    // If mismatches found, offer auto-fix
    if (mismatches.length) {
        console.log('\n── AUTO-FIX ────────────────────────────────────────────');
        console.log('To apply fixes, run: node scripts/verify-weapons.js --fix');
        
        if (process.argv.includes('--fix')) {
            console.log('\nApplying fixes...');
            let content = fs.readFileSync(dbPath, 'utf8');
            let fixCount = 0;
            for (const m of mismatches) {
                const escaped = m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const pattern = new RegExp(
                    `(name:\\s*"${escaped}"[^}]*?weapon:\\s*)"${m.dbWeapon}"`,
                    's'
                );
                const newContent = content.replace(pattern, `$1"${m.prydwenWeapon}"`);
                if (newContent !== content) {
                    content = newContent;
                    fixCount++;
                    console.log(`  Fixed: ${m.name} → ${m.prydwenWeapon}`);
                } else {
                    console.log(`  FAILED to fix: ${m.name} (pattern not found)`);
                }
            }
            fs.writeFileSync(dbPath, content);
            console.log(`\nApplied ${fixCount}/${mismatches.length} fixes.`);
        }
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

verify().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
