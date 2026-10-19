// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mocks so the api module factory can reference them.
const { diagnostics, getDevice, tools, features, toolsDiff, deadLetters, approveFingerprint, invokeTool } =
  vi.hoisted(() => ({
    invokeTool: vi.fn(),
    diagnostics: vi.fn(),
    getDevice: vi.fn(),
    tools: vi.fn(),
    features: vi.fn(),
    toolsDiff: vi.fn(),
    deadLetters: vi.fn(),
    approveFingerprint: vi.fn(),
  }));

vi.mock("../api", () => ({
  api: { diagnostics, getDevice, tools, features, toolsDiff, deadLetters, approveFingerprint, invokeTool },
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));

import { DeviceDetail } from "../components/DeviceDetail";

const DIAG = {
  hostname: "sensor-1",
  mode: "embedded",
  base_url: "http://sensor-1.local",
  spec_url: null,
  transport: "sse",
  reachable: true,
  pod_active: true,
  worker_id: null,
  last_check: 1717500000.0,
  last_check_age_seconds: 4.2,
  spec_hash: "abc123",
  has_manifest: true,
  tool_count: 1,
  tools_revision: 3,
  spawn_error: null,
  breaker: { available: true, state: "closed", fail_counter: 0, fail_max: 5, reset_timeout: 60, note: null },
  tls: { source: "fleet", verify: true, ca_bundle: null, client_cert: false },
};

// The fingerprint fields live on the device record, not on diagnostics — this view
// reads both.
const DEVICE = {
  hostname: "sensor-1",
  base_url: "http://sensor-1.local",
  transport: "sse",
  reachable: true,
  pod_active: true,
  upstream_kind: "openapi",
  upstream_transport: "http",
  tools_revision: 3,
  fingerprint_state: "unpinned",
  // Required by the generated type since ADR-0018 §3 (a schema default renders as required).
  credential_state: "ok",
  fingerprint_policy: null,
};

const TOOLS = {
  hostname: "sensor-1",
  count: 1,
  tools: [
    {
      name: "get_readings",
      description: "Read samples",
      schema: { type: "object" },
      method: "GET",
      path: "/r",
    },
  ],
};

describe("DeviceDetail", () => {
  beforeEach(() => {
    diagnostics.mockReset();
    getDevice.mockReset();
    tools.mockReset();
    features.mockReset();
    toolsDiff.mockReset();
    deadLetters.mockReset();
    approveFingerprint.mockReset();
    invokeTool.mockReset();
    getDevice.mockResolvedValue(DEVICE);
    // Default: a gateway that predates /features, so the tests written against /tools keep
    // exercising the fallback path. The /features tests below override this.
    features.mockRejectedValue(new Error("404"));
    // Default: no recorded tool-set change (panel hidden). Individual tests override.
    toolsDiff.mockResolvedValue({ hostname: "sensor-1", tools_revision: 3, last_change: null });
    // Default: empty dead-letter queue (the DLQ panel mounts inside DeviceDetail).
    deadLetters.mockResolvedValue({ hostname: "sensor-1", count: 0, entries: [] });
  });

  it("renders diagnostics and the tool explorer", async () => {
    diagnostics.mockResolvedValue(DIAG);
    tools.mockResolvedValue(TOOLS);
    render(<DeviceDetail hostname="sensor-1" canWrite={true} onClose={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "sensor-1" })).toBeInTheDocument();
    // Diagnostics + breaker.
    expect(screen.getByText(/closed \(0\/5 failures\)/)).toBeInTheDocument();
    // tools_revision appears twice by design — once as health, once as the behavioural
    // dimension of the fingerprint — so scope this to the diagnostics table.
    const diagTable = screen.getByRole("heading", { name: "Diagnostics" }).nextElementSibling as HTMLElement;
    expect(within(diagTable).getByText("Tools revision").parentElement).toHaveTextContent("3");
    // Tool is listed; its schema is revealed on click.
    const toolButton = screen.getByRole("button", { name: /get_readings/ });
    expect(screen.queryByText(/"type": "object"/)).not.toBeInTheDocument();
    await userEvent.click(toolButton);
    await waitFor(() => expect(screen.getByText(/"type": "object"/)).toBeInTheDocument());
  });

  it("still shows diagnostics when the tools call fails (no active pod)", async () => {
    diagnostics.mockResolvedValue({ ...DIAG, pod_active: false, reachable: false });
    tools.mockRejectedValue(new Error("409"));
    render(<DeviceDetail hostname="sensor-1" canWrite={true} onClose={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "sensor-1" })).toBeInTheDocument();
    expect(screen.getByText(/No tools to show/)).toBeInTheDocument();
  });

  it("shows the recent tool-set change panel, flagging a breaking change", async () => {
    diagnostics.mockResolvedValue(DIAG);
    tools.mockResolvedValue(TOOLS);
    toolsDiff.mockResolvedValue({
      hostname: "sensor-1",
      tools_revision: 4,
      last_change: {
        tools_revision: 4,
        at: 1717500000.0,
        added: ["new_tool"],
        removed: ["gone_tool"],
        changed: [],
        breaking: true,
        breaking_reasons: ["tool(s) removed: ['gone_tool']"],
      },
    });
    render(<DeviceDetail hostname="sensor-1" canWrite={true} onClose={vi.fn()} />);

    expect(await screen.findByText(/Recent tool-set change/)).toBeInTheDocument();
    expect(screen.getByText(/breaking/)).toBeInTheDocument();
    expect(screen.getByText("new_tool")).toBeInTheDocument();
    expect(screen.getByText("gone_tool")).toBeInTheDocument();
    expect(screen.getByText(/tool\(s\) removed/)).toBeInTheDocument();
  });

  it("names a proxied MCP upstream and does not promise spec auto-discovery for it", async () => {
    // The base fixture has no upstream_kind at all, so the openapi case below is the
    // schema default doing the work rather than a seeded value.
    diagnostics.mockResolvedValue(DIAG);
    tools.mockResolvedValue(TOOLS);
    const { rerender } = render(<DeviceDetail hostname="sensor-1" canWrite={true} onClose={vi.fn()} />);
    expect(await screen.findByText("openapi")).toBeInTheDocument();
    expect(screen.getByText("(auto-discovered)")).toBeInTheDocument();

    diagnostics.mockResolvedValue({ ...DIAG, upstream_kind: "mcp", spec_url: null });
    rerender(<DeviceDetail hostname="sensor-2" canWrite={true} onClose={vi.fn()} />);
    expect(await screen.findByText("mcp (proxied server)")).toBeInTheDocument();
    // An MCP upstream has no OpenAPI document; "(auto-discovered)" would be a lie.
    expect(screen.queryByText("(auto-discovered)")).not.toBeInTheDocument();
    expect(screen.getByText(/not used by an MCP upstream/)).toBeInTheDocument();
  });

  it("renders the fingerprint panel from the device record", async () => {
    diagnostics.mockResolvedValue(DIAG);
    tools.mockResolvedValue(TOOLS);
    render(<DeviceDetail hostname="sensor-1" canWrite={true} onClose={vi.fn()} />);

    expect(await screen.findByText("Endpoint fingerprint")).toBeInTheDocument();
    expect(getDevice).toHaveBeenCalledWith("sensor-1");
  });

  it("says so when the device record cannot be read, rather than hiding the panel", async () => {
    // A silently absent security panel reads as "this device has no fingerprint".
    diagnostics.mockResolvedValue(DIAG);
    tools.mockResolvedValue(TOOLS);
    getDevice.mockRejectedValue(new Error("boom"));
    render(<DeviceDetail hostname="sensor-1" canWrite={true} onClose={vi.fn()} />);

    expect(await screen.findByText(/Endpoint fingerprint unavailable/)).toBeInTheDocument();
    // The health view survives it.
    expect(screen.getByText(/closed \(0\/5 failures\)/)).toBeInTheDocument();
  });

  it("re-reads the device after an approval, so the new pin and tool list are current", async () => {
    diagnostics.mockResolvedValue(DIAG);
    tools.mockResolvedValue(TOOLS);
    getDevice.mockResolvedValue({
      ...DEVICE,
      base_url: "https://sensor-1.local",
      fingerprint_state: "pending_approval",
      tls_spki_sha256: "a".repeat(64),
      pending_tls_spki_sha256: "b".repeat(64),
    });
    approveFingerprint.mockResolvedValue({ status: "fingerprint_approved" });
    render(<DeviceDetail hostname="sensor-1" canWrite={true} onClose={vi.fn()} />);

    await userEvent.click(await screen.findByRole("button", { name: /Approve new key/ }));
    // Under an enforce policy the quarantine lifts on approval, so the tool list can
    // become available again — a panel-local refresh would leave it stale.
    await waitFor(() => expect(getDevice).toHaveBeenCalledTimes(2));
    expect(tools).toHaveBeenCalledTimes(2);
  });

  it("notes when there have been no tool-set changes", async () => {
    diagnostics.mockResolvedValue(DIAG);
    tools.mockResolvedValue(TOOLS);
    render(<DeviceDetail hostname="sensor-1" canWrite={true} onClose={vi.fn()} />);

    expect(await screen.findByText(/No tool-set changes since registration/)).toBeInTheDocument();
  });

  it("offers no Run control without the authority to invoke", async () => {
    // `canInvoke` defaults to false, so a caller that never thought about tool invocation
    // cannot hand one out by omission — the direction a default should fail in.
    diagnostics.mockResolvedValue(DIAG);
    getDevice.mockResolvedValue(null);
    toolsDiff.mockResolvedValue(null);
    tools.mockResolvedValue(TOOLS);
    render(<DeviceDetail hostname="sensor-1" canWrite={true} onClose={vi.fn()} />);

    await userEvent.setup().click(await screen.findByRole("button", { name: /get_readings/ }));
    expect(screen.queryByRole("button", { name: /^run /i })).not.toBeInTheDocument();
  });

  it("offers Run once the caller says the session may invoke", async () => {
    diagnostics.mockResolvedValue(DIAG);
    getDevice.mockResolvedValue(null);
    toolsDiff.mockResolvedValue(null);
    tools.mockResolvedValue(TOOLS);
    render(<DeviceDetail hostname="sensor-1" canWrite={true} canInvoke onClose={vi.fn()} />);

    await userEvent.setup().click(await screen.findByRole("button", { name: /get_readings/ }));
    expect(screen.getByRole("button", { name: /run get_readings/i })).toBeInTheDocument();
  });
});

// GET /devices/{h}/features — the drill-down the CLI also reads.
const FEATURES = {
  hostname: "sensor-1",
  upstream_kind: "openapi",
  pod_active: true,
  manifest_cached: true,
  tools_revision: 3,
  server: { name: "Sensor API", version: "1.2.0" },
  discovered: { tools: true, resources: true, prompts: true },
  tools: [
    {
      name: "get_readings",
      description: "Read samples",
      schema: { type: "object" },
      source: "openapi",
      method: "GET",
      path: "/r",
    },
  ],
  resources: [
    {
      uri: "device://sensor-1/status",
      name: "status",
      description: "Device status",
      mime_type: "application/json",
    },
  ],
  prompts: [
    { name: "what_is_sensor", description: "Describe the sensor", template: "You are given…", arguments: [] },
  ],
};

describe("DeviceDetail features", () => {
  beforeEach(() => {
    diagnostics.mockReset();
    getDevice.mockReset();
    tools.mockReset();
    features.mockReset();
    toolsDiff.mockReset();
    deadLetters.mockReset();
    getDevice.mockResolvedValue(DEVICE);
    toolsDiff.mockResolvedValue({ hostname: "sensor-1", tools_revision: 3, last_change: null });
    deadLetters.mockResolvedValue({ hostname: "sensor-1", count: 0, entries: [] });
  });

  it("shows tools, resources and prompts from /features, without calling /tools", async () => {
    diagnostics.mockResolvedValue(DIAG);
    features.mockResolvedValue(FEATURES);
    render(<DeviceDetail hostname="sensor-1" canWrite={false} onClose={vi.fn()} />);

    expect(await screen.findByText("Resources (1)")).toBeInTheDocument();
    expect(screen.getByText("Tools (1)")).toBeInTheDocument();
    expect(screen.getByText("Prompts (1)")).toBeInTheDocument();
    expect(screen.getByText("get_readings")).toBeInTheDocument();
    expect(screen.getByText("device://sensor-1/status")).toBeInTheDocument();
    expect(screen.getByText("what_is_sensor")).toBeInTheDocument();
    expect(screen.getByText(/Sensor API/)).toBeInTheDocument();
    expect(screen.getByText(/cannot fetch prompts through the gateway yet/)).toBeInTheDocument();
    expect(tools).not.toHaveBeenCalled();
  });

  it("lists a down device's tools from the manifest, but will not run them", async () => {
    diagnostics.mockResolvedValue({ ...DIAG, pod_active: false, reachable: false });
    features.mockResolvedValue({ ...FEATURES, pod_active: false });
    render(<DeviceDetail hostname="sensor-1" canWrite={true} canInvoke onClose={vi.fn()} />);

    expect(await screen.findByText(/Listed from the cached manifest/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: /get_readings/ }));
    expect(screen.queryByRole("button", { name: /run get_readings/i })).not.toBeInTheDocument();
    expect(screen.getByText(/no active pod, so its tools cannot run right now/)).toBeInTheDocument();
  });

  it("says features are unknown, not empty, when nothing is cached", async () => {
    diagnostics.mockResolvedValue({ ...DIAG, pod_active: false, has_manifest: false, tool_count: 0 });
    features.mockResolvedValue({
      ...FEATURES,
      pod_active: false,
      manifest_cached: false,
      server: null,
      tools: [],
      resources: [],
      prompts: [],
    });
    render(<DeviceDetail hostname="sensor-1" canWrite={false} onClose={vi.fn()} />);

    expect(await screen.findByText(/unknown, not empty/)).toBeInTheDocument();
    expect(screen.queryByText(/^Resources/)).not.toBeInTheDocument();
    expect(screen.queryByText(/exposes no tools/)).not.toBeInTheDocument();
  });

  it("marks a proxied MCP server's tools, and its resources and prompts as not discovered", async () => {
    diagnostics.mockResolvedValue({ ...DIAG, upstream_kind: "mcp" });
    features.mockResolvedValue({
      ...FEATURES,
      upstream_kind: "mcp",
      server: { name: "reference-upstream", version: "1.0" },
      discovered: { tools: true, resources: false, prompts: false },
      tools: [
        { name: "echo_message", description: "Echo", schema: {}, source: "proxy", method: "", path: "" },
      ],
      resources: [],
      prompts: [],
    });
    render(<DeviceDetail hostname="sensor-1" canWrite={false} onClose={vi.fn()} />);

    expect(await screen.findByText("(proxied)")).toBeInTheDocument();
    expect(screen.getByText(/its resources are not listed/)).toBeInTheDocument();
    expect(screen.getByText(/its prompts are not listed/)).toBeInTheDocument();
    expect(screen.queryByText(/exposes no resources/)).not.toBeInTheDocument();
  });

  it("falls back to /tools against a gateway without /features", async () => {
    diagnostics.mockResolvedValue(DIAG);
    features.mockRejectedValue(new Error("404"));
    tools.mockResolvedValue(TOOLS);
    render(<DeviceDetail hostname="sensor-1" canWrite={false} onClose={vi.fn()} />);

    expect(await screen.findByText("get_readings")).toBeInTheDocument();
    expect(screen.queryByText(/^Resources/)).not.toBeInTheDocument();
    expect(tools).toHaveBeenCalledWith("sensor-1");
  });
});
