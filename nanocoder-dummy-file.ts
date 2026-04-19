// A simple file to give to models to test Nanocoder's functionality

export function greet(name: string): string {
	return `Hello ${name}!`;
}

export function add(a: number, b: number): number {
	return a + b;
}

export function multiply(x: number, y: number): number {
	return x * y;
}

// More functions to make a medium-sized file

export function subtract(a: number, b: number): number {
	return a - b;
}

export function divide(a: number, b: number): number {
	if (b === 0) {
		throw new Error('Division by zero');
	}
	return a / b;
}

export function power(base: number, exponent: number): number {
	return Math.pow(base, exponent);
}

export function sqrt(n: number): number {
	return Math.sqrt(n);
}

export function abs(n: number): number {
	return Math.abs(n);
}

export function round(n: number): number {
	return Math.round(n);
}

export function floor(n: number): number {
	return Math.floor(n);
}

export function ceil(n: number): number {
	return Math.ceil(n);
}

// End of test file
