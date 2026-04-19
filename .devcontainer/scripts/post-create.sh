#!/usr/bin/env bash
set -e

echo "🚀 Setting up Nanocoder development environment..."

# Install dependencies using pnpm
echo "📦 Installing dependencies..."
pnpm install --frozen-lockfile

# Build the project
echo "🔨 Building the project..."
pnpm run build

# Set up Git hooks (if not already set up)
echo "🪝 Setting up Git hooks..."
if [ -f "node_modules/.bin/husky" ]; then
	pnpm run prepare 2>/dev/null || echo "Husky already set up or not needed"
fi

# Verify installation
echo "✅ Verifying installation..."
pnpm test:format || echo "⚠️  Format check failed (expected on first setup)"
pnpm test:types || echo "⚠️  Type check failed (expected on first setup)"

# Create example .env file if it doesn't exist
if [ ! -f .env ]; then
	echo "📝 Creating example .env file..."
	cp .env.example .env
	echo "⚠️  Please edit .env with your API keys"
fi

# Print environment information
echo ""
echo "🌍 Environment Information:"
echo "   Node.js version: $(node --version)"
	echo "   pnpm version: $(pnpm --version)"
	echo "   Biome version: $(biome --version 2>/dev/null || echo 'Not found')"
echo ""

echo "✨ Development environment ready!"
echo ""
echo "📚 Next steps:"
echo "   1. Configure your AI providers in .env or agents.config.json"
echo "   2. Run 'pnpm run dev' to start development mode"
echo "   3. Run 'pnpm test:all' to run all tests"
echo "   4. Run 'pnpm run start' to launch Nanocoder"
echo ""
