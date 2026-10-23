const fs = require("node:fs");

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value || "");
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

const currentVersion = parseVersion(
  JSON.parse(fs.readFileSync("package.json", "utf8")).version,
);
const latestRelease = parseVersion(process.argv[2]);

if (!currentVersion || (process.argv[2] && !latestRelease)) {
  throw new Error("La versione corrente o l'ultimo tag GitHub non è semver valido.");
}

const base =
  latestRelease && compareVersions(latestRelease, currentVersion) > 0
    ? latestRelease
    : currentVersion;
base[2] += 1;
process.stdout.write(base.join("."));
