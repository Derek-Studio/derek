import {existsSync, readFileSync} from 'fs';
import {join} from 'path';

interface FrameworkInfo {
	name: string;
	version?: string;
	category:
		| 'web'
		| 'mobile'
		| 'desktop'
		| 'backend'
		| 'testing'
		| 'build'
		| 'other';
	confidence: 'high' | 'medium' | 'low';
}

interface BuildInfo {
	scripts?: {[script: string]: string};
	buildCommand?: string;
	testCommand?: string;
	devCommand?: string;
	startCommand?: string;
}

interface PackageJson {
	scripts?: {[script: string]: string};
	dependencies?: {[dep: string]: string};
	devDependencies?: {[dep: string]: string};
	peerDependencies?: {[dep: string]: string};
}

export interface ProjectDependencies {
	frameworks: FrameworkInfo[];
	buildTools: string[];
	testingFrameworks: string[];
	buildInfo: BuildInfo;
}

export class FrameworkDetector {
	private static readonly FRAMEWORK_PATTERNS = {
		// Web Frameworks
		react: {name: 'React', category: 'web' as const},
		vue: {name: 'Vue.js', category: 'web' as const},
		angular: {name: 'Angular', category: 'web' as const},
		'@angular/core': {name: 'Angular', category: 'web' as const},
		svelte: {name: 'Svelte', category: 'web' as const},
		next: {name: 'Next.js', category: 'web' as const},
		nuxt: {name: 'Nuxt.js', category: 'web' as const},
		express: {name: 'Express.js', category: 'backend' as const},
		fastify: {name: 'Fastify', category: 'backend' as const},
		koa: {name: 'Koa', category: 'backend' as const},
		nestjs: {name: 'NestJS', category: 'backend' as const},

		// Python Frameworks
		django: {name: 'Django', category: 'backend' as const},
		flask: {name: 'Flask', category: 'backend' as const},
		fastapi: {name: 'FastAPI', category: 'backend' as const},

		// Build Tools
		webpack: {name: 'Webpack', category: 'build' as const},
		vite: {name: 'Vite', category: 'build' as const},
		rollup: {name: 'Rollup', category: 'build' as const},
		parcel: {name: 'Parcel', category: 'build' as const},
		esbuild: {name: 'esbuild', category: 'build' as const},

		// Testing Frameworks
		jest: {name: 'Jest', category: 'testing' as const},
		mocha: {name: 'Mocha', category: 'testing' as const},
		chai: {name: 'Chai', category: 'testing' as const},
		jasmine: {name: 'Jasmine', category: 'testing' as const},
		cypress: {name: 'Cypress', category: 'testing' as const},
		playwright: {name: 'Playwright', category: 'testing' as const},
		vitest: {name: 'Vitest', category: 'testing' as const},

		// Mobile
		'react-native': {name: 'React Native', category: 'mobile' as const},
		flutter: {name: 'Flutter', category: 'mobile' as const},
		ionic: {name: 'Ionic', category: 'mobile' as const},

		// Desktop
		electron: {name: 'Electron', category: 'desktop' as const},
		tauri: {name: 'Tauri', category: 'desktop' as const},
	};

	constructor(private projectPath: string) {}

	/**
	 * Detect frameworks and dependencies in the project
	 */
	public detectDependencies(): ProjectDependencies {
		const result: ProjectDependencies = {
			frameworks: [],
			buildTools: [],
			testingFrameworks: [],
			buildInfo: {},
		};

		// Check different dependency files
		this.checkPackageJson(result);
		this.checkRequirementsTxt(result);
		this.checkCargoToml(result);
		this.checkGoMod(result);

		// Deduplicate frameworks by name
		const uniqueFrameworks = new Map<string, FrameworkInfo>();
		for (const framework of result.frameworks) {
			const existing = uniqueFrameworks.get(framework.name);
			if (!existing || framework.confidence === 'high') {
				uniqueFrameworks.set(framework.name, framework);
			}
		}
		result.frameworks = Array.from(uniqueFrameworks.values());

		// Deduplicate build tools and testing frameworks
		result.buildTools = [...new Set(result.buildTools)];
		result.testingFrameworks = [...new Set(result.testingFrameworks)];

		return result;
	}

	/**
	 * Check package.json for Node.js dependencies
	 */
	private checkPackageJson(result: ProjectDependencies): void {
		const packageJsonPath = join(this.projectPath, 'package.json');

		if (!existsSync(packageJsonPath)) {
			return;
		}

		try {
			const content = readFileSync(packageJsonPath, 'utf-8');
			const packageJson = JSON.parse(content) as PackageJson;

			// Extract build info
			if (packageJson.scripts) {
				result.buildInfo.scripts = packageJson.scripts;
				result.buildInfo.buildCommand = packageJson.scripts.build;
				result.buildInfo.testCommand = packageJson.scripts.test;
				result.buildInfo.devCommand =
					packageJson.scripts.dev || packageJson.scripts['dev:server'];
				result.buildInfo.startCommand = packageJson.scripts.start;
			}

			// Check dependencies and devDependencies
			const allDeps = {
				...packageJson.dependencies,
				...packageJson.devDependencies,
				...packageJson.peerDependencies,
			};

			for (const [depName, version] of Object.entries(allDeps)) {
				const framework = this.matchFramework(depName, version);
				if (framework) {
					result.frameworks.push(framework);

					// Categorize
					if (framework.category === 'build') {
						result.buildTools.push(framework.name);
					} else if (framework.category === 'testing') {
						result.testingFrameworks.push(framework.name);
					}
				}
			}
		} catch {
			// Ignore parsing errors
		}
	}

	/**
	 * Check requirements.txt for Python dependencies
	 */
	private checkRequirementsTxt(result: ProjectDependencies): void {
		const reqPath = join(this.projectPath, 'requirements.txt');

		if (!existsSync(reqPath)) {
			return;
		}

		try {
			const content = readFileSync(reqPath, 'utf-8');
			const lines = content
				.split('\n')
				.filter(line => line.trim() && !line.startsWith('#'));

			for (const line of lines) {
				const depName = line.split(/[>=<]/)[0].trim();
				const framework = this.matchFramework(depName, '');
				if (framework) {
					result.frameworks.push(framework);
				}
			}
		} catch {
			// Ignore parsing errors
		}
	}

	/**
	 * Check Cargo.toml for Rust dependencies
	 */
	private checkCargoToml(result: ProjectDependencies): void {
		const cargoPath = join(this.projectPath, 'Cargo.toml');

		if (!existsSync(cargoPath)) {
			return;
		}

		try {
			const content = readFileSync(cargoPath, 'utf-8');

			// Simple TOML parsing for dependencies section
			const depsMatch = content.match(/\[dependencies\]([\s\S]*?)(?:\[|$)/);
			if (depsMatch) {
				const depsSection = depsMatch[1];
				const lines = depsSection
					.split('\n')
					.filter(line => line.trim() && !line.startsWith('#'));

				for (const line of lines) {
					const match = line.match(/^([^=]+)\s*=/);
					if (match) {
						const depName = match[1].trim();
						const framework = this.matchFramework(depName, '');
						if (framework) {
							result.frameworks.push(framework);
						}
					}
				}
			}

			// Check for common Rust web frameworks
			if (content.includes('actix-web')) {
				result.frameworks.push({
					name: 'Actix Web',
					category: 'backend',
					confidence: 'high',
				});
			}
			if (content.includes('warp')) {
				result.frameworks.push({
					name: 'Warp',
					category: 'backend',
					confidence: 'high',
				});
			}
			if (content.includes('rocket')) {
				result.frameworks.push({
					name: 'Rocket',
					category: 'backend',
					confidence: 'high',
				});
			}
		} catch {
			// Ignore parsing errors
		}
	}

	/**
	 * Check go.mod for Go dependencies
	 */
	private checkGoMod(result: ProjectDependencies): void {
		const goModPath = join(this.projectPath, 'go.mod');

		if (!existsSync(goModPath)) {
			return;
		}

		try {
			const content = readFileSync(goModPath, 'utf-8');

			// Check for common Go frameworks
			if (content.includes('gin-gonic/gin')) {
				result.frameworks.push({
					name: 'Gin',
					category: 'backend',
					confidence: 'high',
				});
			}
			if (content.includes('gorilla/mux')) {
				result.frameworks.push({
					name: 'Gorilla Mux',
					category: 'backend',
					confidence: 'high',
				});
			}
			if (content.includes('echo')) {
				result.frameworks.push({
					name: 'Echo',
					category: 'backend',
					confidence: 'high',
				});
			}
		} catch {
			// Ignore parsing errors
		}
	}

	/**
	 * Match a dependency name to a known framework
	 */
	private matchFramework(
		depName: string,
		version: string,
	): FrameworkInfo | null {
		const pattern =
			FrameworkDetector.FRAMEWORK_PATTERNS[
				depName as keyof typeof FrameworkDetector.FRAMEWORK_PATTERNS
			];

		if (pattern) {
			return {
				name: pattern.name,
				category: pattern.category,
				version: version || undefined,
				confidence: 'high',
			};
		}

		// Check for partial matches with more precise logic
		for (const [key, pattern] of Object.entries(
			FrameworkDetector.FRAMEWORK_PATTERNS,
		)) {
			// Avoid false positives by checking for word boundaries and common prefixes
			const isExactWordMatch = depName === key;
			const hasCommonPrefix =
				depName.startsWith(key + '/') || depName.startsWith(key + '-');
			const isPackageVariant = key.startsWith('@') && depName.startsWith(key);

			// Only match if it's a clear variant of the framework, not just a substring
			if (isExactWordMatch || hasCommonPrefix || isPackageVariant) {
				return {
					name: pattern.name,
					category: pattern.category,
					version: version || undefined,
					confidence: 'medium',
				};
			}
		}

		return null;
	}

	/**
	 * Get build commands based on detected frameworks and package.json
	 */
	public getBuildCommands(): {[key: string]: string} {
		const deps = this.detectDependencies();
		const commands: {[key: string]: string} = {};

		if (deps.buildInfo.scripts) {
			const scripts = deps.buildInfo.scripts;

			// Standard npm/yarn commands
			if (scripts.build) commands['Build'] = 'npm run build';
			if (scripts.test) commands['Test'] = 'npm run test';
			if (scripts.dev) commands['Development'] = 'npm run dev';
			if (scripts.start) commands['Start'] = 'npm run start';
			if (scripts.lint) commands['Lint'] = 'npm run lint';
		}

		// Add language-specific commands
		if (existsSync(join(this.projectPath, 'Cargo.toml'))) {
			commands['Build'] = 'cargo build';
			commands['Test'] = 'cargo test';
			commands['Run'] = 'cargo run';
		}

		if (existsSync(join(this.projectPath, 'go.mod'))) {
			commands['Build'] = 'go build';
			commands['Test'] = 'go test ./...';
			commands['Run'] = 'go run .';
		}

		if (existsSync(join(this.projectPath, 'requirements.txt'))) {
			commands['Install'] = 'pip install -r requirements.txt';
			commands['Test'] = 'python -m pytest';
		}

		return commands;
	}
}
