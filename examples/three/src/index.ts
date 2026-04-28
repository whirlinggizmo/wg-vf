import { LocalApp } from "./local-app";

// Launcher UI
const launcher = document.getElementById("launcher")!;
const app = document.getElementById("app")!;
const viewport = document.getElementById("viewport")!;
const sidebar = document.getElementById("sidebar")!;

let currentApp: LocalApp | null = null;

function showLauncher() {
  launcher.hidden = false;
  app.hidden = true;
}

function showApp() {
  launcher.hidden = true;
  app.hidden = false;
}

function createLauncherUI() {
  launcher.innerHTML = `
    <div class="launcher-card">
      <div class="launcher-header">
        <div class="eyebrow">Vignette Framework</div>
        <h1>Three.js Example</h1>
        <p class="intro">
          Launch the same local Three.js scene against either the TypeScript vignette or the Nim-built WebAssembly vignette.
        </p>
      </div>
      <ul class="client-list">
        <li>
          <a href="#" class="client-link" id="connect-local-js">
            <div class="client-title">TypeScript Vignette</div>
            <div class="client-meta">
              <span class="client-tag">JS</span>
              Run JavaScript vignette (TypeScript source) in a local worker
            </div>
          </a>
        </li>
        <li>
          <a href="#" class="client-link" id="connect-local-wasm">
            <div class="client-title">Nim Vignette (WASM)</div>
            <div class="client-meta">
              <span class="client-tag">WASM</span>
              Run WebAssembly vignette (Nim source) in a local worker
            </div>
          </a>
        </li>
      </ul>
    </div>
  `;

  // Add event listeners
  document.getElementById("connect-local-js")?.addEventListener("click", (e) => {
    e.preventDefault();
    connectLocal("js");
  });

  document.getElementById("connect-local-wasm")?.addEventListener("click", (e) => {
    e.preventDefault();
    connectLocal("wasm");
  });
}

function createSidebarControls() {
  sidebar.innerHTML = `
    <div style="margin-bottom: 16px;">
      <h3 style="margin: 0 0 8px 0; font-size: 14px;">Controls</h3>
      <button id="spawn-entity" style="width: 100%; padding: 8px; margin-bottom: 8px; cursor: pointer;">
        Spawn Random Entity
      </button>
      <button id="disconnect" style="width: 100%; padding: 8px; cursor: pointer; background: #ff4444; color: white; border: none; border-radius: 4px;">
        Disconnect
      </button>
    </div>
    <div>
      <h3 style="margin: 0 0 8px 0; font-size: 14px;">Status</h3>
      <div id="status" style="font-size: 11px; color: #666;">Connected</div>
    </div>
  `;

  document.getElementById("spawn-entity")?.addEventListener("click", async () => {
    if (currentApp) {
      const { encodePayload } = await import("../../codecs/json-codec");
      await currentApp["bridge"].handleMessage(encodePayload({ type: "SpawnRandomEntity" }));
    }
  });

  document.getElementById("disconnect")?.addEventListener("click", async () => {
    if (currentApp) {
      await currentApp.disconnect();
      currentApp = null;
      showLauncher();
    }
  });
}

async function connectLocal(type: "js" | "wasm") {
  console.log(`[main] Connecting to local ${type} vignette...`);

  try {
    currentApp = new LocalApp(type);
    createSidebarControls();
    showApp();

    await currentApp.run(viewport);
  } catch (err) {
    console.error("[main] Failed to connect:", err);
    alert(`Failed to connect: ${err instanceof Error ? err.message : String(err)}`);
    showLauncher();
  }
}

// Initialize
console.log("[main] Three.js example starting...");
createLauncherUI();
showLauncher();
