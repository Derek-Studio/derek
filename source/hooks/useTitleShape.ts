import {createContext, useContext} from 'react';
import type {TitleShape} from '@/components/ui/styled-title';
import {
	getTitleShape as getTitleShapeFromPrefs,
	updateTitleShape as updateTitleShapeInPrefs,
} from '@/config/preferences';

interface TitleShapeContextType {
	currentTitleShape: TitleShape;
	setCurrentTitleShape: (shape: TitleShape) => void;
}

export const TitleShapeContext = createContext<TitleShapeContextType | null>(
	null,
);

export function useTitleShape(): TitleShapeContextType {
	const context = useContext(TitleShapeContext);
	if (!context) {
		throw new Error('useTitleShape must be used within a TitleShapeProvider');
	}
	return context;
}

/**
 * Helper function to get initial title shape from preferences
 */
export function getInitialTitleShape(): TitleShape {
	return getTitleShapeFromPrefs() || 'pill';
}

/**
 * Helper function to update title shape in both context and preferences
 */
export function updateTitleShape(shape: TitleShape): void {
	updateTitleShapeInPrefs(shape);
}
