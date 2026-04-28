import * as THREE from "three";
import { VignetteBridge, type VignetteType } from "../../../src";
import { decodePayload, encodePayload } from "../../codecs/json-codec";

// Entity type matching the vignette
interface Entity {
  id: string;
  x: number;
  y: number;
  z: number;
  type: "cube" | "sphere";
  color: number;
}

export type LocalConnectOptions = {
  mode: "local";
  vignetteType: VignetteType;
  moduleUrl: string;
};

export type RemoteConnectOptions = {
  mode: "remote";
  remoteUrl: string;
};

export abstract class BaseApp {
  protected bridge = new VignetteBridge();
  protected scene!: THREE.Scene;
  protected camera!: THREE.PerspectiveCamera;
  protected renderer!: THREE.WebGLRenderer;
  protected entities: Map<string, THREE.Mesh> = new Map();
  protected readonly vignetteType: VignetteType;

  protected constructor(vignetteType: VignetteType) {
    this.vignetteType = vignetteType;
  }

  protected getVignetteUrl(type: VignetteType): string {
    switch (type) {
      case "wasm":
        return new URL("../vignette/nim/out/three-vignette_wasm.js", import.meta.url).href;
      case "js":
        return new URL("../vignette/ts/out/three-vignette.js", import.meta.url).href;
    }
  }

  abstract getConnectOptions(): LocalConnectOptions | RemoteConnectOptions;
  abstract getInitPayload(): Uint8Array;

  protected log(...args: any[]) {
    console.log(`[three-app]`, ...args);
  }

  protected initRenderer(container: HTMLElement): void {
    // Scene setup
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x222222);

    // Camera
    this.camera = new THREE.PerspectiveCamera(
      75,
      container.clientWidth / container.clientHeight,
      0.1,
      1000
    );
    this.camera.position.z = 15;
    this.camera.position.y = 5;
    this.camera.lookAt(0, 0, 0);

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);

    // Lighting
    const ambientLight = new THREE.AmbientLight(0x404040, 2);
    this.scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 2);
    directionalLight.position.set(10, 10, 10);
    this.scene.add(directionalLight);

    // Grid helper
    const gridHelper = new THREE.GridHelper(20, 20);
    this.scene.add(gridHelper);

    // Handle resize
    window.addEventListener("resize", () => {
      this.camera.aspect = container.clientWidth / container.clientHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(container.clientWidth, container.clientHeight);
    });

    // Start render loop
    this.animate();
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    this.renderer.render(this.scene, this.camera);
  };

  protected createEntityMesh(entity: Entity): THREE.Mesh {
    let geometry: THREE.BufferGeometry;

    if (entity.type === "sphere") {
      geometry = new THREE.SphereGeometry(0.5, 32, 32);
    } else {
      geometry = new THREE.BoxGeometry(1, 1, 1);
    }

    const material = new THREE.MeshStandardMaterial({
      color: entity.color,
      roughness: 0.5,
      metalness: 0.1,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(entity.x, entity.y, entity.z);
    mesh.userData = { id: entity.id };

    return mesh;
  }

  protected updateEntity(entity: Entity): void {
    let mesh = this.entities.get(entity.id);

    if (!mesh) {
      // Create new mesh
      mesh = this.createEntityMesh(entity);
      this.scene.add(mesh);
      this.entities.set(entity.id, mesh);
      this.log("Created entity:", entity.id, entity.type);
    } else {
      // Update position
      mesh.position.set(entity.x, entity.y, entity.z);
    }
  }

  protected removeEntity(id: string): void {
    const mesh = this.entities.get(id);
    if (mesh) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      this.entities.delete(id);
      this.log("Removed entity:", id);
    }
  }

  protected handleVignetteMessage(payload: Uint8Array): void {
    const msg = decodePayload(payload) as { type: string; entity?: Entity; entities?: Entity[] };

    switch (msg.type) {
      case "EntitySpawned":
        if (msg.entity) {
          this.updateEntity(msg.entity);
        }
        break;

      case "EntityMoved":
        if (msg.entity) {
          this.updateEntity(msg.entity);
        }
        break;

      case "StateUpdate":
        if (msg.entities) {
          // Update all entities
          for (const entity of msg.entities) {
            this.updateEntity(entity);
          }

          // Remove entities that are no longer present
          const currentIds = new Set(msg.entities.map((e) => e.id));
          for (const [id] of this.entities) {
            if (!currentIds.has(id)) {
              this.removeEntity(id);
            }
          }
        }
        break;
    }
  }

  async run(container: HTMLElement): Promise<void> {
    this.initRenderer(container);

    await this.bridge.connect(this.getConnectOptions());
    await this.bridge.init(this.getInitPayload());
    await this.bridge.handleMessage(encodePayload({ type: "SpawnPlayer" }));

    this.log("Connected to vignette");

    // Spawn a few random entities
    for (let i = 0; i < 5; i++) {
      await this.bridge.handleMessage(encodePayload({ type: "SpawnRandomEntity" }));
    }

    // Poll for messages from vignette
    const pollInterval = setInterval(() => {
      const messages = this.bridge.pollOutbox();
      for (const payload of messages) {
        this.handleVignetteMessage(payload);
      }
    }, 16); // ~60fps

    // Cleanup on disconnect
    return new Promise((resolve) => {
      // Store cleanup function for later
      (this as any).cleanup = () => {
        clearInterval(pollInterval);
        resolve();
      };
    });
  }

  async disconnect(): Promise<void> {
    await this.bridge.disconnect();
    // Trigger cleanup
    const cleanup = (this as any).cleanup;
    if (cleanup) cleanup();
  }
}
