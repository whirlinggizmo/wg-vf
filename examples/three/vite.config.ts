import { defineConfig } from "vite";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const homeDir = os.homedir();
const tlsEnabled = readEnableTlsEnv();

function getSSLKeysPath(): { certPath: string; privKeyPath: string } | null {
  if (!tlsEnabled) {
    return null;
  }

  let certsDir = (process.env.CERTS_DIR || path.join(homeDir, "keys")).trim();
  if (!fs.existsSync(certsDir)) {
    console.warn(`Certificates directory not found: ${certsDir}`);
    certsDir = "";
  }

  const hostname = (process.env.HOSTNAME || os.hostname()).trim();
  const privKeyPath = path.join(certsDir, hostname, "privkey.pem");
  if (!fs.existsSync(privKeyPath)) {
    console.warn(`Private key not found: ${privKeyPath}`);
    return null;
  }

  const certPath = path.join(certsDir, hostname, "cert.pem");
  if (!fs.existsSync(certPath)) {
    console.warn(`Certificate not found: ${certPath}`);
    return null;
  }

  return { certPath, privKeyPath };
}

const sslKeysPaths = getSSLKeysPath();
console.log(`Will use ${sslKeysPaths ? "SSL" : "non-SSL"} connection`);

export default defineConfig({
  publicDir: "public",
  base: "./",
  appType: "mpa",
  server: {
    host: "0.0.0.0",
    port: 3000,
    strictPort: true,
    cors: true,
    headers: {
      "access-control-allow-origin": "*",
    },
    open: false,
    https: sslKeysPaths
      ? {
          key: fs.readFileSync(sslKeysPaths.privKeyPath),
          cert: fs.readFileSync(sslKeysPaths.certPath),
        }
      : undefined,
    fs: {
      allow: ["..", "../../.."], // Allow access to wg-vf src and examples
    },
  },
});

function readEnableTlsEnv(): boolean {
  const raw = (process.env.ENABLE_TLS ?? "true").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "no" && raw !== "off";
}
