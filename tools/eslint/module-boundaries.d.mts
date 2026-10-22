// Types of module-boundaries.mjs for the server tests that import its allow-lists (AOS-21.47).
import type { ESLint, Rule } from 'eslint';

export declare const SERVER_SRC: string;
export declare const SYSTEM_DB_FILES: string[];
export declare const INTERNAL_CALL_FILES: string[];
export declare const SECOND_DB_FILES: string[];
export declare const SECOND_DB_MODULES: RegExp;
export declare const OPEN_DB_FILES: string[];
export declare const SPACE_ROUTE_FILES: string[];
export declare const SPACE_PREFIX_MODULES: string[];
export declare function declaredSpaceRoutes(text?: string): Set<string>;
export declare function serverRelative(filename: string): string | null;
export declare const moduleBoundariesRule: Rule.RuleModule;
export declare const medlevoPlugin: ESLint.Plugin;
export default medlevoPlugin;
