export function privatePath(path) {
  if (path === '.env.example') return false;
  return /(?:^|\/)(?:\.env(?:\..+)?|\.secrets|secrets|credentials|\.ssh|\.aws|\.dsh|\.artifacts|\.playwright-cli|\.venv|__pycache__|browser-profile|browser-output|node_modules|data|artifacts|backups|media|workspaces|extensions|cache|tmp|run)(?:\/|$)/i.test(path)
    || /(?:^|\/)output\/playwright(?:\/|$)/i.test(path)
    || /\.py[cod]$/i.test(path)
    || /(?:\.local(?:\..*)?|\.(?:pem|key|p12|pfx|keystore|sqlite(?:3)?(?:-.*)?|db(?:-.*)?|log))$/i.test(path)
    || /(?:^|\/)(?:\.npmrc|\.netrc|compose\.override\.ya?ml)$/.test(path)
    || path === 'scripts/verify-social.mjs';
}
