/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Red Hat, Inc. All rights reserved.
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { JSONSchema, JSONSchemaMap, JSONSchemaRef } from '../jsonSchema07';
import { SchemaRequestService, WorkspaceContextService, PromiseConstructor, Thenable } from '../yamlLanguageService';
import { UnresolvedSchema, ResolvedSchema, JSONSchemaService,
    SchemaDependencies, ISchemaContributions } from 'vscode-json-languageservice/lib/umd/services/jsonSchemaService';

import * as nls from 'vscode-nls';
import { convertSimple2RegExpPattern } from '../utils/strings';
const localize = nls.loadMessageBundle();

export declare type CustomSchemaProvider = (uri: string) => Thenable<string>;

export class FilePatternAssociation {

    private schemas: string[];
    private patternRegExp: RegExp;

    constructor(pattern: string) {
        try {
            this.patternRegExp = new RegExp(convertSimple2RegExpPattern(pattern) + '$');
        } catch (e) {
            // invalid pattern
            this.patternRegExp = null;
        }
        this.schemas = [];
    }

    public addSchema(id: string) {
        this.schemas.push(id);
    }

    public matchesPattern(fileName: string): boolean {
        return this.patternRegExp && this.patternRegExp.test(fileName);
    }

    public getSchemas() {
        return this.schemas;
    }
}

export class YAMLSchemaService extends JSONSchemaService {

    private customSchemaProvider: CustomSchemaProvider | undefined;
    private filePatternAssociations: FilePatternAssociation[];
    private contextService: WorkspaceContextService;

    constructor(requestService: SchemaRequestService, contextService?: WorkspaceContextService, promiseConstructor?: PromiseConstructor) {
        super(requestService, contextService, promiseConstructor);
        this.customSchemaProvider = undefined;
    }

    registerCustomSchemaProvider(customSchemaProvider: CustomSchemaProvider) {
        this.customSchemaProvider = customSchemaProvider;
    }

    //tslint:disable
    public resolveSchemaContent(schemaToResolve: UnresolvedSchema, schemaURL: string, dependencies: SchemaDependencies): Thenable<ResolvedSchema> {

        let resolveErrors: string[] = schemaToResolve.errors.slice(0);
        let schema = schemaToResolve.schema;
        let contextService = this.contextService;

        let findSection = (schema: JSONSchema, path: string): any => {
            if (!path) {
                return schema;
            }
            let current: any = schema;
            if (path[0] === '/') {
                path = path.substr(1);
            }
            path.split('/').some((part) => {
                current = current[part];
                return !current;
            });
            return current;
        };

        let merge = (target: JSONSchema, sourceRoot: JSONSchema, sourceURI: string, path: string): void => {
            let section = findSection(sourceRoot, path);
            if (section) {
                for (let key in section) {
                    if (section.hasOwnProperty(key) && !target.hasOwnProperty(key)) {
                        target[key] = section[key];
                    }
                }
            } else {
                resolveErrors.push(localize('json.schema.invalidref', '$ref \'{0}\' in \'{1}\' can not be resolved.', path, sourceURI));
            }
        };

        let resolveExternalLink = (node: JSONSchema, uri: string, linkPath: string, parentSchemaURL: string, parentSchemaDependencies: SchemaDependencies): Thenable<any> => {
            if (contextService && !/^\w+:\/\/.*/.test(uri)) {
                uri = contextService.resolveRelativePath(uri, parentSchemaURL);
            }
            uri = this.normalizeId(uri);
            const referencedHandle = this.getOrAddSchemaHandle(uri);
            return referencedHandle.getUnresolvedSchema().then(unresolvedSchema => {
                parentSchemaDependencies[uri] = true;
                if (unresolvedSchema.errors.length) {
                    let loc = linkPath ? uri + '#' + linkPath : uri;
                    resolveErrors.push(localize('json.schema.problemloadingref', 'Problems loading reference \'{0}\': {1}', loc, unresolvedSchema.errors[0]));
                }
                merge(node, unresolvedSchema.schema, uri, linkPath);
                return resolveRefs(node, unresolvedSchema.schema, uri, referencedHandle.dependencies);
            });
        };

        let resolveRefs = (node: JSONSchema, parentSchema: JSONSchema, parentSchemaURL: string, parentSchemaDependencies: SchemaDependencies): Thenable<any> => {
            if (!node || typeof node !== 'object') {
                return Promise.resolve(null);
            }

            let toWalk: JSONSchema[] = [node];
            let seen: JSONSchema[] = [];

            let openPromises: Thenable<any>[] = [];

            let collectEntries = (...entries: JSONSchemaRef[]) => {
                for (let entry of entries) {
                    if (typeof entry === 'object') {
                        toWalk.push(entry);
                    }
                }
            };
            let collectMapEntries = (...maps: JSONSchemaMap[]) => {
                for (let map of maps) {
                    if (typeof map === 'object') {
                        for (let key in map) {
                            let entry = map[key];
                            if (typeof entry === 'object') {
                                toWalk.push(entry);
                            }
                        }
                    }
                }
            };
            let collectArrayEntries = (...arrays: JSONSchemaRef[][]) => {
                for (let array of arrays) {
                    if (Array.isArray(array)) {
                        for (let entry of array) {
                            if (typeof entry === 'object') {
                                toWalk.push(entry);
                            }
                        }
                    }
                }
            };
            let handleRef = (next: JSONSchema) => {
                let seenRefs = [];
                while (next.$ref) {
                    const ref = next.$ref;
                    let segments = ref.split('#', 2);
                    delete next.$ref;
                    if (segments[0].length > 0) {
                        openPromises.push(resolveExternalLink(next, segments[0], segments[1], parentSchemaURL, parentSchemaDependencies));
                        return;
                    } else {
                        if (seenRefs.indexOf(ref) === -1) {
                            merge(next, parentSchema, parentSchemaURL, segments[1]); // can set next.$ref again, use seenRefs to avoid circle
                            seenRefs.push(ref);
                        }
                    }
                }

                collectEntries(<JSONSchema>next.items, <JSONSchema>next.additionalProperties, next.not, next.contains, next.propertyNames, next.if, next.then, next.else);
                collectMapEntries(next.definitions, next.properties, next.patternProperties, <JSONSchemaMap>next.dependencies);
                collectArrayEntries(next.anyOf, next.allOf, next.oneOf, <JSONSchema[]>next.items, next.schemaSequence);
            };

            while (toWalk.length) {
                let next = toWalk.pop();
                if (seen.indexOf(next) >= 0) {
                    continue;
                }
                seen.push(next);
                handleRef(next);
            }
            return Promise.all(openPromises);
        };

        return resolveRefs(schema, schema, schemaURL, dependencies).then(_ => new ResolvedSchema(schema, resolveErrors));
    }
    //tslint:enable

    public getSchemaForResource(resource: string, doc = undefined): Thenable<ResolvedSchema> {
        const resolveSchema = () => {

            const seen: { [schemaId: string]: boolean } = Object.create(null);
            const schemas: string[] = [];
            for (const entry of this.filePatternAssociations) {
                if (entry.matchesPattern(resource)) {
                    for (const schemaId of entry.getSchemas()) {
                        if (!seen[schemaId]) {
                            schemas.push(schemaId);
                            seen[schemaId] = true;
                        }
                    }
                }
            }

            if (schemas.length > 0) {
                return super.createCombinedSchema(resource, schemas).getResolvedSchema().then(schema => {
                    if (schema.schema && schema.schema.schemaSequence && schema.schema.schemaSequence[doc.currentDocIndex]) {
                        return new ResolvedSchema(schema.schema.schemaSequence[doc.currentDocIndex]);
                    }
                    return schema;
                });
            }

            return Promise.resolve(null);
        };
        if (this.customSchemaProvider) {
            return this.customSchemaProvider(resource)
                       .then(schemaUri => {
                           if (!schemaUri) {
                               return resolveSchema();
                           }

                           return this.loadSchema(schemaUri)
                               .then(unsolvedSchema => this.resolveSchemaContent(unsolvedSchema, schemaUri, []).then(schema => {
                                if (schema.schema && schema.schema.schemaSequence && schema.schema.schemaSequence[doc.currentDocIndex]) {
                                    return new ResolvedSchema(schema.schema.schemaSequence[doc.currentDocIndex]);
                                }
                                return schema;
                            }));
                        })
                       .then(schema => schema, err => resolveSchema());
        } else {
            return resolveSchema();
        }
    }

    /**
     * Everything below here is needed because we're importing from vscode-json-languageservice umd and we need
     * to provide a wrapper around the javascript methods we are calling since they have no type
     */

    normalizeId(id: string) {
        return super.normalizeId(id);
    }

    getOrAddSchemaHandle(id: string, unresolvedSchemaContent?: JSONSchema) {
        return super.getOrAddSchemaHandle(id, unresolvedSchemaContent);
    }

    // tslint:disable-next-line: no-any
    loadSchema(schemaUri: string): Thenable<any> {
        return super.loadSchema(schemaUri);
    }

    registerExternalSchema(uri: string, filePatterns?: string[], unresolvedSchema?: JSONSchema) {
        return super.registerExternalSchema(uri, filePatterns, unresolvedSchema);
    }

    clearExternalSchemas(): void {
        super.clearExternalSchemas();
    }

    setSchemaContributions(schemaContributions: ISchemaContributions): void {
        super.setSchemaContributions(schemaContributions);
    }

    getRegisteredSchemaIds(filter?: (scheme: any) => boolean): string[] {
        return super.getRegisteredSchemaIds(filter);
    }

    getResolvedSchema(schemaId: string): Thenable<ResolvedSchema> {
        return super.getResolvedSchema(schemaId);
    }

    onResourceChange(uri: string): boolean {
        return super.onResourceChange(uri);
    }
}
