import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'fs';
import {join} from 'path';
import test from 'ava';
import {FrameworkDetector} from './framework-detector';

console.log('\nframework-detector.spec.ts');

// Helper to create a temporary test project
function createTempProject(): string {
	const tempDir = mkdtempSync('nanocoder-test-');
	mkdirSync(tempDir, {recursive: true});
	return tempDir;
}

// Helper to clean up temp directory
function cleanupTempDir(tempDir: string): void {
	if (existsSync(tempDir)) {
		rmSync(tempDir, {recursive: true, force: true});
	}
}

// ============================================================================
// Basic Detection Tests
// ============================================================================

test('FrameworkDetector handles empty project directory', t => {
	const tempDir = createTempProject();

	try {
		const detector = new FrameworkDetector(tempDir);
		const result = detector.detectDependencies();

		t.deepEqual(result.frameworks, []);
		t.deepEqual(result.buildTools, []);
		t.deepEqual(result.testingFrameworks, []);
		t.deepEqual(result.buildInfo, {});
	} finally {
		cleanupTempDir(tempDir);
	}
});

test('FrameworkDetector handles non-existent directory', t => {
	const tempDir = createTempProject();
	rmSync(tempDir, {recursive: true, force: true});

	try {
		const detector = new FrameworkDetector(tempDir);
		const result = detector.detectDependencies();

		// Should not throw, just return empty results
		t.truthy(result);
		t.deepEqual(result.frameworks, []);
	} finally {
		// No need to cleanup if it doesn't exist
	}
});

// ============================================================================
// package.json Detection Tests
// ============================================================================

test('FrameworkDetector detects React in package.json', t => {
	const tempDir = createTempProject();

	try {
		const packageJson = {
			dependencies: {
				react: '^18.0.0',
				'react-dom': '^18.0.0',
			},
		};
		writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

		const detector = new FrameworkDetector(tempDir);
		const result = detector.detectDependencies();

		t.true(result.frameworks.some(f => f.name === 'React'));
	} finally {
		cleanupTempDir(tempDir);
	}
});

test('FrameworkDetector detects Vue.js in package.json', t => {
	const tempDir = createTempProject();

	try {
		const packageJson = {
			dependencies: {
				vue: '^3.0.0',
			},
		};
		writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

		const detector = new FrameworkDetector(tempDir);
		const result = detector.detectDependencies();

		t.true(result.frameworks.some(f => f.name === 'Vue.js'));
	} finally {
		cleanupTempDir(tempDir);
	}
});

test('FrameworkDetector detects Angular in package.json', t => {
	const tempDir = createTempProject();

	try {
		const packageJson = {
			dependencies: {
				'@angular/core': '^15.0.0',
			},
		};
		writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

		const detector = new FrameworkDetector(tempDir);
		const result = detector.detectDependencies();

		t.true(result.frameworks.some(f => f.name === 'Angular'));
	} finally {
		cleanupTempDir(tempDir);
	}
});

test('FrameworkDetector detects Next.js in package.json', t => {
	const tempDir = createTempProject();

	try {
		const packageJson = {
			dependencies: {
				next: '^14.0.0',
			},
		};
		writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

		const detector = new FrameworkDetector(tempDir);
		const result = detector.detectDependencies();

		t.true(result.frameworks.some(f => f.name === 'Next.js'));
	} finally {
		cleanupTempDir(tempDir);
	}
});

test('FrameworkDetector detects Express.js in package.json', t => {
	const tempDir = createTempProject();

	try {
		const packageJson = {
			dependencies: {
				express: '^4.18.0',
			},
		};
		writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

		const detector = new FrameworkDetector(tempDir);
		const result = detector.detectDependencies();

		t.true(result.frameworks.some(f => f.name === 'Express.js'));
	} finally {
		cleanupTempDir(tempDir);
	}
});

test('FrameworkDetector detects multiple frameworks', t => {
	const tempDir = createTempProject();

	try {
		const packageJson = {
			dependencies: {
				react: '^18.0.0',
				vite: '^5.0.0',
				jest: '^29.0.0',
			},
		};
		writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

		const detector = new FrameworkDetector(tempDir);
		const result = detector.detectDependencies();

		t.true(result.frameworks.some(f => f.name === 'React'));
		t.true(result.frameworks.some(f => f.name === 'Vite'));
		t.true(result.frameworks.some(f => f.name === 'Jest'));
	} finally {
		cleanupTempDir(tempDir);
	}
});

test('FrameworkDetector categorizes build tools correctly', t => {
	const tempDir = createTempProject();

	try {
		const packageJson = {
			devDependencies: {
				webpack: '^5.0.0',
				vite: '^5.0.0',
			},
		};
		writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

		const detector = new FrameworkDetector(tempDir);
		const result = detector.detectDependencies();

		t.true(result.buildTools.includes('Webpack'));
		t.true(result.buildTools.includes('Vite'));
	} finally {
		cleanupTempDir(tempDir);
	}
});

test('FrameworkDetector categorizes testing frameworks correctly', t => {
	const tempDir = createTempProject();

	try {
		const packageJson = {
			devDependencies: {
				jest: '^29.0.0',
				cypress: '^13.0.0',
			},
		};
		writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

		const detector = new FrameworkDetector(tempDir);
		const result = detector.detectDependencies();

		t.true(result.testingFrameworks.includes('Jest'));
		t.true(result.testingFrameworks.includes('Cypress'));
	} finally {
		cleanupTempDir(tempDir);
	}
});

// ============================================================================
// Build Info Extraction Tests
// ============================================================================

test('FrameworkDetector extracts build info from package.json', t => {
	const tempDir = createTempProject();

	try {
		const packageJson = {
			scripts: {
				build: 'tsc',
				test: 'jest',
				dev: 'vite',
				start: 'node index.js',
			},
		};
		writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

		const detector = new FrameworkDetector(tempDir);
		const result = detector.detectDependencies();

		t.is(result.buildInfo.buildCommand, 'tsc');
		t.is(result.buildInfo.testCommand, 'jest');
		t.is(result.buildInfo.devCommand, 'vite');
		t.is(result.buildInfo.startCommand, 'node index.js');
	} finally {
		cleanupTempDir(tempDir);
	}
});

test('FrameworkDetector handles dev:server script', t => {
	const tempDir = createTempProject();

	try {
		const packageJson = {
			scripts: {
				'dev:server': 'vite',
			},
		};
		writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

		const detector = new FrameworkDetector(tempDir);
		const result = detector.detectDependencies();

		t.is(result.buildInfo.devCommand, 'vite');
	} finally {
		cleanupTempDir(tempDir);
	}
});

// ============================================================================
// Python requirements.txt Tests
// ============================================================================

test('FrameworkDetector detects Django in requirements.txt', t => {
	const tempDir = createTempProject();

	try {
		const requirements = 'django>=4.0.0\n';
		writeFileSync(join(tempDir, 'requirements.txt'), requirements);

		const detector = new FrameworkDetector(tempDir);
		const result = detector.detectDependencies();

		t.true(result.frameworks.some(f => f.name === 'Django'));
	} finally {
		cleanupTempDir(tempDir);
	}
});

test('FrameworkDetector detects Flask in requirements.txt', t => {
	const tempDir = createTempProject();

	try {
		const requirements = 'flask>=3.0.0\n';
		writeFileSync(join(tempDir, 'requirements.txt'), requirements);

		const detector = new FrameworkDetector(tempDir);
		const result = detector.detectDependencies();

		t.true(result.frameworks.some(f => f.name === 'Flask'));
	} finally {
		cleanupTempDir(tempDir);
	}
});

test('FrameworkDetector detects FastAPI in requirements.txt', t => {
	const tempDir = createTempProject();

	try {
		const requirements = 'fastapi>=0.100.0\n';
		writeFileSync(join(tempDir, 'requirements.txt'), requirements);

		const detector = new FrameworkDetector(tempDir);
		const result = detector.detectDependencies();

		t.true(result.frameworks.some(f => f.name === 'FastAPI'));
	} finally {
		cleanupTempDir(tempDir);
	}
});

test('FrameworkDetector filters comments in requirements.txt', t => {
	const tempDir = createTempProject();

	try {
		const requirements = '# This is a comment\ndjango>=4.0.0\n# Another comment\nflask>=3.0.0\n';
		writeFileSync(join(tempDir, 'requirements.txt'), requirements);

		const detector = new FrameworkDetector(tempDir);
		const result = detector.detectDependencies();

		t.true(result.frameworks.some(f => f.name === 'Django'));
		t.true(result.frameworks.some(f => f.name === 'Flask'));
	} finally {
		cleanupTempDir(tempDir);
	}
});

// ============================================================================
// Rust Cargo.toml Tests
// ============================================================================

test('FrameworkDetector detects Actix Web in Cargo.toml', t => {
	const tempDir = createTempProject();

	try {
		const cargoToml = `
[dependencies]
actix-web = "4.0"
`;
		writeFileSync(join(tempDir, 'Cargo.toml'), cargoToml);

		const detector = new FrameworkDetector(tempDir);
		const result = detector.detectDependencies();

		t.true(result.frameworks.some(f => f.name === 'Actix Web'));
	} finally {
		cleanupTempDir(tempDir);
	}
});

test('FrameworkDetector detects Rocket in Cargo.toml', t => {
	const tempDir = createTempProject();

	try {
		const cargoToml = `
[dependencies]
rocket = "0.5"
`;
		writeFileSync(join(tempDir, 'Cargo.toml'), cargoToml);

		const detector = new FrameworkDetector(tempDir);
		const result = detector.detectDependencies();

		t.true(result.frameworks.some(f => f.name === 'Rocket'));
	} finally {
		cleanupTempDir(tempDir);
	}
});

// ============================================================================
// Go go.mod Tests
// ============================================================================

test('FrameworkDetector detects Gin in go.mod', t => {
	const tempDir = createTempProject();

	try {
		const goMod = `
module test

require (
	github.com/gin-gonic/gin v1.9.0
)
`;
		writeFileSync(join(tempDir, 'go.mod'), goMod);

		const detector = new FrameworkDetector(tempDir);
		const result = detector.detectDependencies();

		t.true(result.frameworks.some(f => f.name === 'Gin'));
	} finally {
		cleanupTempDir(tempDir);
	}
});

test('FrameworkDetector detects Gorilla Mux in go.mod', t => {
	const tempDir = createTempProject();

	try {
		const goMod = `
module test

require github.com/gorilla/mux v1.8.0
`;
		writeFileSync(join(tempDir, 'go.mod'), goMod);

		const detector = new FrameworkDetector(tempDir);
		const result = detector.detectDependencies();

		t.true(result.frameworks.some(f => f.name === 'Gorilla Mux'));
	} finally {
		cleanupTempDir(tempDir);
	}
});

test('FrameworkDetector detects Echo in go.mod', t => {
	const tempDir = createTempProject();

	try {
		const goMod = `
module test

require github.com/labstack/echo/v4 v4.0.0
`;
		writeFileSync(join(tempDir, 'go.mod'), goMod);

		const detector = new FrameworkDetector(tempDir);
		const result = detector.detectDependencies();

		t.true(result.frameworks.some(f => f.name === 'Echo'));
	} finally {
		cleanupTempDir(tempDir);
	}
});

// ============================================================================
// Build Commands Tests
// ============================================================================

test('FrameworkDetector gets build commands for Node.js project', t => {
	const tempDir = createTempProject();

	try {
		const packageJson = {
			scripts: {
				build: 'tsc',
				test: 'jest',
				dev: 'vite',
			},
		};
		writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

		const detector = new FrameworkDetector(tempDir);
		const commands = detector.getBuildCommands();

		t.is(commands['Build'], 'npm run build');
		t.is(commands['Test'], 'npm run test');
		t.is(commands['Development'], 'npm run dev');
	} finally {
		cleanupTempDir(tempDir);
	}
});

test('FrameworkDetector gets build commands for Rust project', t => {
	const tempDir = createTempProject();

	try {
		const cargoToml = `
[package]
name = "test"
`;
		writeFileSync(join(tempDir, 'Cargo.toml'), cargoToml);

		const detector = new FrameworkDetector(tempDir);
		const commands = detector.getBuildCommands();

		t.is(commands['Build'], 'cargo build');
		t.is(commands['Test'], 'cargo test');
		t.is(commands['Run'], 'cargo run');
	} finally {
		cleanupTempDir(tempDir);
	}
});

test('FrameworkDetector gets build commands for Go project', t => {
	const tempDir = createTempProject();

	try {
		const goMod = `
module test
`;
		writeFileSync(join(tempDir, 'go.mod'), goMod);

		const detector = new FrameworkDetector(tempDir);
		const commands = detector.getBuildCommands();

		t.is(commands['Build'], 'go build');
		t.is(commands['Test'], 'go test ./...');
		t.is(commands['Run'], 'go run .');
	} finally {
		cleanupTempDir(tempDir);
	}
});

test('FrameworkDetector gets build commands for Python project', t => {
	const tempDir = createTempProject();

	try {
		writeFileSync(join(tempDir, 'requirements.txt'), 'django>=4.0.0\n');

		const detector = new FrameworkDetector(tempDir);
		const commands = detector.getBuildCommands();

		t.is(commands['Install'], 'pip install -r requirements.txt');
		t.is(commands['Test'], 'python -m pytest');
	} finally {
		cleanupTempDir(tempDir);
	}
});

// ============================================================================
// Deduplication Tests
// ============================================================================

test('FrameworkDetector deduplicates frameworks by name', t => {
	const tempDir = createTempProject();

	try {
		// Create both package.json with react and requirements.txt (which won't have react)
		const packageJson = {
			dependencies: {
				react: '^18.0.0',
			},
			devDependencies: {
				react: '^18.0.0',
			},
		};
		writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

		const detector = new FrameworkDetector(tempDir);
		const result = detector.detectDependencies();

		// React should only appear once
		const reactFrameworks = result.frameworks.filter(f => f.name === 'React');
		t.is(reactFrameworks.length, 1);
	} finally {
		cleanupTempDir(tempDir);
	}
});

test('FrameworkDetector deduplicates build tools', t => {
	const tempDir = createTempProject();

	try {
		const packageJson = {
			devDependencies: {
				vite: '^5.0.0',
			},
			peerDependencies: {
				vite: '^5.0.0',
			},
		};
		writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

		const detector = new FrameworkDetector(tempDir);
		const result = detector.detectDependencies();

		// Vite should only appear once in buildTools
		const viteCount = result.buildTools.filter(t => t === 'Vite').length;
		t.is(viteCount, 1);
	} finally {
		cleanupTempDir(tempDir);
	}
});

test('FrameworkDetector deduplicates testing frameworks', t => {
	const tempDir = createTempProject();

	try {
		const packageJson = {
			devDependencies: {
				jest: '^29.0.0',
			},
			peerDependencies: {
				jest: '^29.0.0',
			},
		};
		writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

		const detector = new FrameworkDetector(tempDir);
		const result = detector.detectDependencies();

		// Jest should only appear once
		const jestCount = result.testingFrameworks.filter(t => t === 'Jest').length;
		t.is(jestCount, 1);
	} finally {
		cleanupTempDir(tempDir);
	}
});

// ============================================================================
// Edge Cases
// ============================================================================

test('FrameworkDetector handles malformed package.json', t => {
	const tempDir = createTempProject();

	try {
		writeFileSync(join(tempDir, 'package.json'), '{ invalid json }');

		const detector = new FrameworkDetector(tempDir);
		const result = detector.detectDependencies();

		// Should not throw, just return empty results
		t.truthy(result);
		t.deepEqual(result.frameworks, []);
	} finally {
		cleanupTempDir(tempDir);
	}
});

test('FrameworkDetector handles empty package.json', t => {
	const tempDir = createTempProject();

	try {
		writeFileSync(join(tempDir, 'package.json'), '{}');

		const detector = new FrameworkDetector(tempDir);
		const result = detector.detectDependencies();

		t.truthy(result);
		t.deepEqual(result.frameworks, []);
	} finally {
		cleanupTempDir(tempDir);
	}
});

test('FrameworkDetector handles unknown dependencies', t => {
	const tempDir = createTempProject();

	try {
		const packageJson = {
			dependencies: {
				'unknown-package': '^1.0.0',
				'another-random-lib': '^2.0.0',
			},
		};
		writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

		const detector = new FrameworkDetector(tempDir);
		const result = detector.detectDependencies();

		// Unknown packages should not create framework entries
		t.true(result.frameworks.length === 0);
	} finally {
		cleanupTempDir(tempDir);
	}
});

test('FrameworkDetector handles mobile frameworks', t => {
	const tempDir = createTempProject();

	try {
		const packageJson = {
			dependencies: {
				'react-native': '^0.72.0',
			},
		};
		writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

		const detector = new FrameworkDetector(tempDir);
		const result = detector.detectDependencies();

		t.true(result.frameworks.some(f => f.name === 'React Native'));
		t.is(result.frameworks[0].category, 'mobile');
	} finally {
		cleanupTempDir(tempDir);
	}
});

test('FrameworkDetector handles desktop frameworks', t => {
	const tempDir = createTempProject();

	try {
		const packageJson = {
			devDependencies: {
				electron: '^27.0.0',
			},
		};
		writeFileSync(join(tempDir, 'package.json'), JSON.stringify(packageJson, null, 2));

		const detector = new FrameworkDetector(tempDir);
		const result = detector.detectDependencies();

		t.true(result.frameworks.some(f => f.name === 'Electron'));
		t.is(result.frameworks[0].category, 'desktop');
	} finally {
		cleanupTempDir(tempDir);
	}
});
