# Nanocoder VS Code Extension

VS Code integration for [Nanocoder](https://github.com/Nano-Collective/nanocoder) - a local-first AI coding assistant.

## Features

- **Ask About Code**: Right-click on selected code to ask Nanocoder questions about it directly from VS Code
- **Live Diff Preview**: See proposed file changes in VS Code's diff viewer before approving them in the CLI
- **Automatic Connection**: Seamlessly connects to the Nanocoder CLI when running with `--vscode`
- **Status Bar Integration**: Quick connection status and controls from the VS Code status bar
- **Diagnostics Sharing**: VS Code's LSP diagnostics (errors, warnings) are shared with Nanocoder for context

## Installation

### Automatic Installation (Recommended)

When you run Nanocoder with the `--vscode` flag for the first time, it will prompt you to install the extension automatically:

```bash
nanocoder --vscode
```

### Manual Installation

#### From VSIX

After installing Nanocoder, the extension VSIX is bundled in the package:

```bash
# Find the VSIX location (npm global install)
code --install-extension $(npm root -g)/@nanocollective/nanocoder/assets/nanocoder-vscode.vsix
```

Or install via VS Code UI:

1. Open VS Code
2. Press `Ctrl+Shift+P` / `Cmd+Shift+P`
3. Type "Extensions: Install from VSIX..."
4. Select the `nanocoder-vscode.vsix` file

#### From Source

1. Navigate to the extension directory:

   ```bash
   cd plugins/vscode
   ```

2. Install dependencies:

   ```bash
   pnpm install
   ```

3. Build and package the extension:

   ```bash
   pnpm run build
   pnpm exec vsce package --allow-missing-repository --skip-license --no-dependencies
   ```

4. Install the generated `.vsix` file in VS Code

### Development

```bash
# Watch for changes
pnpm run watch

# Build for production
pnpm run build

# Package for distribution
pnpm exec vsce package --allow-missing-repository --skip-license --no-dependencies
```

## Usage

### Starting Nanocoder with VS Code Support

Run Nanocoder with the `--vscode` flag to enable the WebSocket server:

```bash
nanocoder --vscode
```

Or with a custom port:

```bash
nanocoder --vscode --vscode-port 51821
```

### How It Works

1. **Start the CLI**: Run `nanocoder --vscode` in your project directory
2. **Extension connects**: The VS Code extension automatically connects to the CLI
3. **View diffs**: When Nanocoder proposes file changes, a diff view opens in VS Code showing:
   - Original content on the left
   - Proposed changes on the right
   - Syntax highlighting for the file type
4. **Approve/reject in CLI**: Use the Nanocoder CLI to approve or reject changes

### Ask About Code (Context Menu)

Select code in any file and right-click to see "Ask Nanocoder about this". This lets you:

1. Select any code in VS Code
2. Right-click and choose "Ask Nanocoder about this"
3. Enter your question in the input box
4. The question and code context are sent to the Nanocoder CLI
5. Nanocoder responds in the CLI with full context of your selected code

The code reference appears in the CLI as a highlighted placeholder (e.g., `[@App.tsx (lines 10-25)]`) while the full code is sent to the AI for analysis.

### Commands

Access via Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

| Command                                | Description                                  |
| -------------------------------------- | -------------------------------------------- |
| `Nanocoder: Connect to Nanocoder`      | Manually connect to the running CLI          |
| `Nanocoder: Disconnect from Nanocoder` | Disconnect from the CLI                      |
| `Nanocoder: Start Nanocoder CLI`       | Open a terminal and run `nanocoder --vscode` |
| `Nanocoder: Ask Nanocoder about this`  | Ask about selected code (also in context menu) |

### Status Bar

The status bar item shows the current connection state:

- `$(plug) Nanocoder` - Not connected (click to connect)
- `$(check) Nanocoder` - Connected to CLI
- `$(check) model-name` - Connected and showing current model
- `$(sync~spin) Connecting...` - Connection in progress

### Configuration

Configure the extension in VS Code settings (`Ctrl+,` / `Cmd+,`):

| Setting                     | Default | Description                                      |
| --------------------------- | ------- | ------------------------------------------------ |
| `nanocoder.serverPort`      | `51820` | WebSocket server port for CLI communication      |
| `nanocoder.autoConnect`     | `true`  | Automatically connect to CLI on VS Code startup  |
| `nanocoder.showDiffPreview` | `true`  | Automatically show diff preview for file changes |

## Architecture

```
┌─────────────────┐     WebSocket      ┌──────────────────┐
│   VS Code       │◄──────────────────►│   Nanocoder CLI  │
│   Extension     │    (port 51820)    │   (--vscode)     │
└─────────────────┘                    └──────────────────┘
        │                                       │
        ▼                                       ▼
  • Diff Preview                          • AI Processing
  • Status Bar                            • Tool Execution
  • Diagnostics                           • File Operations
```

## Protocol

The extension and CLI communicate via JSON messages over WebSocket:

### CLI → Extension

| Message Type          | Description                                  |
| --------------------- | -------------------------------------------- |
| `connection_ack`      | Connection acknowledgment with version info  |
| `file_change`         | Proposed file modification with diff content |
| `assistant_message`   | AI response (streaming or complete)          |
| `status`              | Current model/provider/connection status     |
| `diagnostics_request` | Request LSP diagnostics from VS Code         |

### Extension → CLI

| Message Type           | Description                                           |
| ---------------------- | ----------------------------------------------------- |
| `send_prompt`          | User question with optional code selection context    |
| `apply_change`         | User approved a file change                           |
| `reject_change`        | User rejected a file change                           |
| `context`              | Workspace info (open files, active file, diagnostics) |
| `diagnostics_response` | LSP diagnostics data from VS Code                     |
| `get_status`           | Request current CLI status                            |

## Troubleshooting

### Extension not connecting?

- Ensure Nanocoder is running with the `--vscode` flag
- Check the Nanocoder output channel: `View > Output > Nanocoder`
- Verify port 51820 is not blocked or in use by another application
- Try manually connecting via Command Palette: "Nanocoder: Connect to Nanocoder"

### Diff not showing?

- Ensure `nanocoder.showDiffPreview` is enabled in VS Code settings
- Check that the extension is connected (status bar shows checkmark)
- The diff appears when a tool proposes file changes, before you approve in the CLI

### Connection drops?

- This can happen when the CLI restarts
- Click the status bar item to reconnect
- Enable `nanocoder.autoConnect` for automatic reconnection on startup

## License

MIT - See the main [Nanocoder repository](https://github.com/Nano-Collective/nanocoder) for details.
