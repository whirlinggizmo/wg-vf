import * as THREE from "three";
import {
  messagePortBytePeer,
  Channel,
  SystemType,
  encodeSystemEnvelope,
  encodeAppEnvelope,
  encodeInitPayload,
  decodeEnvelope,
  decodeReadyPayload,
  decodeErrorPayload,
  type BytePeer,
  type MessagePortLike,
} from "../../../src";
import { decodePayload, encodePayload } from "../../codecs/json-codec";

interface Entity {
  id: number;
  x: number;
  y: number;
  z: number;
  type: "cube" | "sphere";
  color: number;
}

export type VignetteKind = "js" | "wasm";

// The three.js app. The vignette runs in a Web Worker; the app talks to it over
// a postMessage BytePeer using the ordinary envelope protocol. Vignette state
// arrives on the App channel as JSON and drives the scene.
export class ThreeApp {
  private worker: Worker | null = null;
  private peer: BytePeer | null = null;

  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private readonly entities = new Map<number, THREE.Mesh>();
  private animationFrameId: number | null = null;
  private isRendering = false;
  private resizeHandler: (() => void) | null = null;
  private renderContainer: HTMLElement | null = null;

  constructor(private readonly kind: VignetteKind) {}

  private log(...args: unknown[]): void {
    console.log(`[three-app]`, ...args);
  }

  // --- session ------------------------------------------------------------

  async run(container: HTMLElement): Promise<void> {
    this.initRenderer(container);

    this.worker = new Worker(new URL("./three-worker.ts", import.meta.url), { type: "module" });
    this.peer = messagePortBytePeer(this.worker as unknown as MessagePortLike);
    this.peer.onBytes((bytes) => this.onBytes(bytes));

    // Name the vignette (js or wasm binding); the host resolves it from the
    // worker's manifest. SpawnPlayer follows on Ready.
    this.peer.send(
      encodeSystemEnvelope(
        SystemType.Init,
        encodeInitPayload({
          vignetteId: `three-${this.kind}`,
          initPayload: encodePayload({ type: "Init", scene: "three-demo" }),
        }),
      ),
    );
    this.log(`provisioning 'three-${this.kind}' vignette in worker`);
  }

  sendMessage(msg: unknown): void {
    this.peer?.send(encodeAppEnvelope(encodePayload(msg)));
  }

  spawnEntity(): void {
    this.sendMessage({ type: "SpawnRandomEntity" });
  }

  disconnect(): void {
    this.worker?.terminate();
    this.worker = null;
    this.peer = null;
    this.disposeRenderer();
  }

  private onBytes(bytes: Uint8Array): void {
    const env = decodeEnvelope(bytes);
    if (env.channel === Channel.System) {
      if (env.systemType === SystemType.Ready) {
        this.log("ready:", decodeReadyPayload(env.payload));
        this.sendMessage({ type: "SpawnPlayer" });
      } else if (env.systemType === SystemType.Error) {
        this.log("error:", decodeErrorPayload(env.payload));
      }
      return;
    }
    if (env.channel === Channel.App) {
      this.handleVignetteMessage(env.payload);
    }
  }

  private handleVignetteMessage(payload: Uint8Array): void {
    const msg = decodePayload(payload) as { type: string; entity?: Entity; entities?: Entity[] };
    switch (msg.type) {
      case "EntitySpawned":
      case "EntityMoved":
        if (msg.entity) this.updateEntity(msg.entity);
        break;
      case "StateUpdate":
        if (msg.entities) {
          for (const entity of msg.entities) this.updateEntity(entity);
          const present = new Set(msg.entities.map((e) => e.id));
          for (const [id] of this.entities) if (!present.has(id)) this.removeEntity(id);
        }
        break;
    }
  }

  // --- three.js rendering -------------------------------------------------

  private initRenderer(container: HTMLElement): void {
    this.renderContainer = container;
    container.replaceChildren();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x222222);

    this.camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 1000);
    this.camera.position.set(0, 5, 15);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);

    this.scene.add(new THREE.AmbientLight(0x404040, 2));
    const dir = new THREE.DirectionalLight(0xffffff, 2);
    dir.position.set(10, 10, 10);
    this.scene.add(dir);
    this.scene.add(new THREE.GridHelper(20, 20));

    this.resizeHandler = () => {
      this.camera.aspect = container.clientWidth / container.clientHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(container.clientWidth, container.clientHeight);
    };
    window.addEventListener("resize", this.resizeHandler);

    this.isRendering = true;
    this.animate();
  }

  private animate = (): void => {
    if (!this.isRendering) return;
    this.animationFrameId = requestAnimationFrame(this.animate);
    this.renderer.render(this.scene, this.camera);
  };

  private createEntityMesh(entity: Entity): THREE.Mesh {
    const geometry =
      entity.type === "sphere" ? new THREE.SphereGeometry(0.5, 32, 32) : new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial({ color: entity.color, roughness: 0.5, metalness: 0.1 });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(entity.x, entity.y, entity.z);
    mesh.userData = { id: entity.id };
    return mesh;
  }

  private updateEntity(entity: Entity): void {
    let mesh = this.entities.get(entity.id);
    if (!mesh) {
      mesh = this.createEntityMesh(entity);
      this.scene.add(mesh);
      this.entities.set(entity.id, mesh);
    } else {
      mesh.position.set(entity.x, entity.y, entity.z);
    }
  }

  private removeEntity(id: number): void {
    const mesh = this.entities.get(id);
    if (!mesh) return;
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
    this.entities.delete(id);
  }

  private disposeRenderer(): void {
    this.isRendering = false;
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    if (this.resizeHandler) {
      window.removeEventListener("resize", this.resizeHandler);
      this.resizeHandler = null;
    }
    this.scene?.traverse((object) => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose();
    });
    this.entities.clear();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.domElement.remove();
    }
    this.renderContainer?.replaceChildren();
    this.renderContainer = null;
  }
}
