import EventEmitter from "events";

export function Debouncer<Params extends unknown[]>(callback: (...params: Params) => unknown, timeoutMs: number) {
    let timeout: NodeJS.Timeout | undefined = undefined
    return {
        Exec: (...params: Params) => (timeout && clearTimeout(timeout), timeout = setTimeout(() => callback(...params), timeoutMs)),
        Terminate: () => (timeout && clearTimeout(timeout), timeout = undefined),
    }
}

type Debouncer<Params extends unknown[] = []> = ReturnType<typeof Debouncer<Params>>;

// Allow adding new entrypoints/deps in real time (forces rebuild)
// Allow rebuild debounce

export type BuildResult<Metadata extends object, ErrorCode extends string> = BuilderBuildResult<Metadata, ErrorCode> | (Partial<Metadata> & {
    state: 'built'
    buildStyle: 'cached'
})

export type BuilderBuildResult<Metadata extends object, ErrorCode extends string> = Partial<Metadata> &
    (
        | {
            state: 'built'
            buildStyle: 'full'
        }
        | {
            state: 'error'
            errors: BuildError<ErrorCode>[]
        }
    )

export type BuildStatus<ItemId extends string, Metadata extends object, ErrorCode extends string> = {
    /** The last _successful_ build id - does not update when the build errors even as the rest of the data does */
    _lastBuildId: number
    _lastChangedBuildId: number
    _buildData:
    {
        // The builder that processed this entrypoint 
        builder: BuilderInstance<ItemId, Metadata, ErrorCode>
    } &
    (
        | {
            // This state can only happen before the first build
            state: 'pending'
        }
        | BuildResult<Metadata, ErrorCode>
    )
}

export type BuildError<ErrorCode extends string> = {
    errorType: 'compile-error' | 'validation-error' | 'dependency-failure';
    errorCode: ErrorCode | 'build-aborted' | 'missing-dependencies' | 'errored-dependencies' | 'unknown-error';
    message: string;
    location?: string;
}

/**
 * The different changes that can occur to an entrypoint
 * 
 * - discovered - register as new entrypoint and force clear _all_ caches
 * - changed - rebuild entrypoint and all of its dependencies
 * - dependencies-changed - refresh dependencies cache for entrypoint and then rebuild
 * - deleted - entrypoint deleted - remove any reference in all caches
 */
export type EntrypointChanged = 'discovered' | 'changed' | 'dependencies-changed' | 'deleted'

export type BuilderInstance<ItemId extends string, Metadata extends object, ErrorCode extends string> = {
    builderType: string;
    itemId: ItemId;
    dependencies: () => ItemId[];
    watch: (onChange: (change: Extract<EntrypointChanged, 'changed' | 'dependencies-changed'>) => void) => Promise<void>;
    build: (metadata: Partial<Metadata>, signal: AbortSignal) => Promise<BuilderBuildResult<Metadata, ErrorCode>>
    dispose: (metadata: Partial<Metadata>) => Promise<void>
}

export type Builder<ItemId extends string, Metadata extends object, ErrorCode extends string> = (itemId: ItemId, prod: boolean) =>
    Promise<BuilderInstance<ItemId, Metadata, ErrorCode>>;

export type BuildStatusCode = 'started' | 'interrupted' | 'finished';

export default class BuildOrchestrator<ItemIds extends string, Metadata extends object, ErrorCode extends string> {
    private _currentBuildId = 0;
    private _isCurrentlyBuilding = false;
    private _lastBuildSucceeded = false;
    private _currentlyBuilding = new Map<ItemIds, AbortController>();
    private _remainingBuildItems = new Set<ItemIds>();
    private _buildStatus: {
        [Key in ItemIds]?: BuildStatus<Key, Metadata, ErrorCode>
    } = {};

    private _dependsOn: {
        [Key in ItemIds]?: Set<ItemIds>
    } = {};
    private _usedBy: {
        [Key in ItemIds]?: Set<ItemIds>
    } = {};

    private readonly _prod: boolean;
    private readonly _watch: boolean;
    private readonly _buildDebounce: Debouncer;

    public constructor(
        prod: boolean,
        watch: boolean,
        debounceMs: number,
    ) {
        this._prod = prod;
        this._watch = watch;
        this._buildDebounce = Debouncer(() => this.StartBuild(), debounceMs);
    }

    public get IsCurrentlyBuilding() {
        return this._isCurrentlyBuilding;
    }

    public get BuildReport(): { readonly [Key in ItemIds]?: Readonly<BuildStatus<Key, Metadata, ErrorCode>> } {
        return this._buildStatus;
    }

    public get IsValid() {
        return !this.IsCurrentlyBuilding && this._lastBuildSucceeded;
    }

    public readonly Events = new EventEmitter<{
        'build-status-changed': [BuildStatusCode];
    }>();


    public ForceRebuild() {
        this._buildDebounce.Terminate();
        this.InterruptBuild();
        const allItems = Object.keys(this._buildStatus) as ItemIds[];
        allItems.forEach(itemId => this._buildStatus[itemId]!._lastChangedBuildId = this._currentBuildId + 1);
        this._buildDebounce.Exec();
    }

    private StartBuild() {
        // We can't start a build while we're already in the middle of one
        if (this.IsCurrentlyBuilding) return;
        this.Events.emit('build-status-changed', 'started');
        // Increment the build id
        this._currentBuildId++;
        this._isCurrentlyBuilding = true;
        const allItems = Object.keys(this._buildStatus) as ItemIds[];
        const rootItems = allItems.filter(itemId => !this._dependsOn[itemId]);

        // Mark all items as planned for building
        allItems.forEach(itemId => this._remainingBuildItems.add(itemId));
        // Initiate build for all root entry points
        rootItems.forEach(itemId => this.TryRebuildEntrypoint(itemId));
        // Try to finish the build (for cases where no root entrypoints were found)
        this.TryFinishBuild();
    }

    private TryRebuildEntrypoint<ItemId extends ItemIds>(itemId: ItemId, dependencyChanged: boolean = false) {
        const dependsOn = this._dependsOn[itemId];
        // This should always exist
        const status = this._buildStatus[itemId]!;
        const builder = status._buildData.builder;

        if(dependencyChanged) status._lastChangedBuildId = this._currentBuildId;
        // If there exists a dependency which is still not built, OR missing, OR currently building, OR errored on its current build - we cannot build ourselves
        if ([...dependsOn ?? []].some(dep => this._remainingBuildItems.has(dep) || !this._buildStatus[dep] || this._currentlyBuilding.has(dep) || this._buildStatus[dep]._buildData.state === 'error')) {
            return;
        }

        if (this._remainingBuildItems.delete(itemId)) {
            // Can the build be cached
            if (status._lastBuildId >= status._lastChangedBuildId) {
                status._lastBuildId = this._currentBuildId;
                const report = {
                    state: "built",
                    buildStyle: "cached",
                } satisfies BuildResult<Metadata, ErrorCode>;

                status._buildData = {
                    ...status._buildData,
                    ...report,
                }

                this.OnEntrypointBuilt(itemId, true);
            }
            // If it cannot be cached, initiate a full build
            else {
                const abortController = new AbortController();
                this._currentlyBuilding.set(itemId, abortController);

                new Promise<BuildResult<Metadata, ErrorCode>>((resolve, reject) => {
                    abortController.signal.addEventListener("abort", () => reject("build-aborted"));
                    builder.build(status._buildData as Metadata, abortController.signal).then(resolve, reject);
                }).then(result => {
                    if(this._currentlyBuilding.get(itemId) !== abortController) {
                        // Item was deleted
                        return;
                    }
                    status._buildData = {
                        builder,
                        ...result,
                    }

                    // If the build succeeded, we run post build normally
                    if (result.state === 'built') {
                        status._lastBuildId = this._currentBuildId;
                        this.OnEntrypointBuilt(itemId, true, true);
                    }
                    // Otherwise, we try to finish the build
                    else {
                        this.OnEntrypointBuilt(itemId, false);
                    }
                }, failure => {
                    if(this._currentlyBuilding.get(itemId) !== abortController) {
                        // Item was deleted
                        return;
                    }
                    const report = {
                        state: "error",
                        errors: [{
                            errorType: "compile-error",
                            errorCode: failure === "build-aborted" ? "build-aborted" : "unknown-error",
                            message: failure === "build-aborted" ? "The build was aborted" : `An error occured - ${failure}`,
                        }]
                    } satisfies BuildResult<Metadata, ErrorCode>;

                    status._buildData = {
                        // This can technically carry over unexpected fields, but also the build should never actually error in normal usage so it's not crucial
                        ...status._buildData,
                        ...report,
                    }

                    // Try to finish the build
                    this.OnEntrypointBuilt(itemId, false);
                });
            }
        }
    }

    private OnEntrypointBuilt<ItemId extends ItemIds>(itemId: ItemId, success: boolean, changed: boolean = false) {
        this._currentlyBuilding.delete(itemId);
        if (success) {
            const usedBy = this._usedBy[itemId];
            if (usedBy) {
                [...usedBy].forEach((user) => this.TryRebuildEntrypoint(user, changed));
            }
        }
        setImmediate(() => this.TryFinishBuild());
    }

    private InterruptEntrypointBuild<ItemId extends ItemIds>(itemId: ItemId) {
        this._currentlyBuilding.get(itemId)?.abort();
    }

    private InterruptBuild() {
        [...this._currentlyBuilding.keys()].forEach(itemId => this.InterruptEntrypointBuild(itemId));
        this.TryFinishBuild();
    }

    private TryFinishBuild() {
        // We can't finish a build when no build is ongoing
        if (!this.IsCurrentlyBuilding) return;
        // A build can only be finished when no entrypoints are currently being built
        if (this._currentlyBuilding.size === 0) {
            this._isCurrentlyBuilding = false;
            // The build succeeds if no entry points errored, AND we have no remaining build items
            this._lastBuildSucceeded = this._remainingBuildItems.size === 0 && !(Object.keys(this._buildStatus) as ItemIds[]).some(itemId => this._buildStatus[itemId]!._buildData.state === "error");

            this.Events.emit('build-status-changed', this._lastBuildSucceeded ? 'finished' : 'interrupted');
            // Now, if we did have remaining build items, it means they were waiting for dependencies that never built
            // As such, we mark those appropriately
            if (!this._lastBuildSucceeded) {
                [...this._remainingBuildItems].forEach(itemId => {
                    // This should always exist
                    const status = this._buildStatus[itemId]!;
                    const dependencies = [...this._dependsOn[itemId] ?? []];

                    const missingDeps = dependencies.filter(dep => !this._buildStatus[dep]);
                    const erroredDeps = dependencies.filter(dep => this._remainingBuildItems.has(dep) || this._buildStatus[dep]?._buildData.state === "error");
                    const report = {
                        state: "error",
                        errors: ([
                            missingDeps.length > 0 && {
                                errorType: "dependency-failure",
                                errorCode: 'missing-dependencies',
                                message: `The following dependencies used by this entrypoint were not located - [${missingDeps.join(", ")}]`,
                            },
                            erroredDeps.length > 0 && {
                                errorType: "dependency-failure",
                                errorCode: 'errored-dependencies',
                                message: `The following dependencies used by this entrypoint did not build correctly - [${erroredDeps.join(", ")}]`,
                            },
                            dependencies.length === 0 && {
                                errorType: "compile-error",
                                errorCode: 'build-aborted',
                                message: 'The build was forcefuly cancelled before this root item could be built'
                            },
                        ] satisfies (BuildError<ErrorCode> | false)[]).filter(Boolean) as BuildError<ErrorCode>[]
                    } satisfies BuildResult<Metadata, ErrorCode>

                    status._buildData = {
                        ...status._buildData,
                        ...report,
                    }

                    status._lastChangedBuildId = this._currentBuildId;
                })
            }

            this._remainingBuildItems.clear();
        }
    }

    public async AddEntrypoint<ItemId extends ItemIds>(itemId: ItemId, builder: Builder<ItemId, Metadata, ErrorCode>) {
        await this.RemoveEntrypoint(itemId);

        const builderInstance = await builder(itemId, this._prod);
        this._buildStatus[itemId] = {
            _lastBuildId: -1,
            _lastChangedBuildId: this._currentBuildId,
            _buildData: {
                builder: builderInstance,
                state: "pending",
            }
        } satisfies BuildStatus<ItemId, Metadata, ErrorCode>;

        this.RefreshDependencies(itemId, builderInstance.dependencies());
        if (this._watch) await builderInstance.watch((change) => this.OnEntrypointChanged(itemId, change));
        this.OnEntrypointChanged(itemId, "discovered");
    }

    public async RemoveEntrypoint<ItemId extends ItemIds>(itemId: ItemId) {
        if (!this._buildStatus[itemId]) return;

        const dependencies = this._dependsOn[itemId];
        if (dependencies) {
            [...dependencies].forEach(dep => this.RemoveDependency(dep, itemId));
        }
        delete this._dependsOn[itemId];
        this.OnEntrypointChanged(itemId, "deleted");
    }

    private RefreshDependencies<ItemId extends ItemIds>(itemId: ItemId, dependencies: ItemIds[]) {
        const oldDependencies = new Set<ItemIds>(this._dependsOn[itemId] ?? []);
        if (dependencies.length > 0) {
            dependencies.forEach(dep => {
                this._usedBy[dep] ??= new Set();
                this._usedBy[dep].add(itemId);
                oldDependencies.delete(dep);
            });
            this._dependsOn[itemId] = new Set(dependencies);
        } else {
            delete this._dependsOn[itemId];
        }

        [...oldDependencies].forEach(dep => this.RemoveDependency(dep, itemId));
    }

    private RemoveDependency(dep: ItemIds, itemId: ItemIds) {
        const set = this._usedBy[dep];
        if (set) set.delete(itemId);
        if (set && set.size === 0) delete this._usedBy[dep];
    }

    private OnEntrypointChanged<ItemId extends ItemIds>(itemId: ItemId, change: EntrypointChanged) {
        // This method only does anything significant in watch mode - to build in non-watch mode simply call build when you're ready
        if (!this._watch) return;

        const isCurrentlyBuilding = this.IsCurrentlyBuilding;

        let rebuildEntrypoint = false;
        let fullRebuild = !isCurrentlyBuilding; // If we aren't building and a change happened - rebuild

        switch (change) {
            case "dependencies-changed":
                this.RefreshDependencies(itemId, this._buildStatus[itemId]?._buildData.builder.dependencies() ?? []);
            case "changed":
                const status = this._buildStatus[itemId]!;
                if (isCurrentlyBuilding) {
                    // If we're currently building this entrypoint (or already finished it) - restart the build
                    if (this._currentlyBuilding.has(itemId) || !this._remainingBuildItems.has(itemId)) {
                        fullRebuild ||= true;
                        // In case we force a rebuild, we register this entrypoint as having changed in the next rebuild
                        status._lastChangedBuildId = this._currentBuildId + 1;
                    } else {
                        // If this entrypoint wasn't built yet - just make sure it is rebuilt
                        rebuildEntrypoint = true;
                        // In case the entrypoint wasn't built yet, we can also try to greedily set it to having changed in this build
                        status._lastChangedBuildId = this._currentBuildId;
                    }
                } else {
                    // Mark this entrypoint as changed for the next rebuild
                    status._lastChangedBuildId = this._currentBuildId + 1;
                }
                break;
            case "discovered":
                // We only care if we're currently building to update the running build - since every new build recalculates the build plan anyways
                if (isCurrentlyBuilding) {
                    // If we're currently building - simply add this entrypoint to the plan and try to build it
                    rebuildEntrypoint = true;
                }
                break;
            case "deleted":
                if (isCurrentlyBuilding) {
                    if (this._remainingBuildItems.delete(itemId)) {
                        // We successfully prevented this entrypoint from building
                    }
                    else if (this._currentlyBuilding.has(itemId)) {
                        // We successfully interrupted this entrypoint from building, the build is still salvagable
                        this.InterruptEntrypointBuild(itemId);
                        this._currentlyBuilding.delete(itemId);
                    }
                    else {
                        // The entrypoint was already build and already polluted the build - force a full rebuild
                        fullRebuild = true;
                    }
                }

                // Now we can run the post-deletion logic for the entrypoing
                const buildData = this._buildStatus[itemId]!._buildData;
                const builder = buildData!.builder;
                // TODO - introduce some sort of mechanism to make sure an entrypoing can't be re-added until its dispose method finishes running
                // In practice, for now this shouldn't really cause any issues due to debounces
                builder.dispose(buildData as BuildResult<Metadata, ErrorCode>);
                delete this._buildStatus[itemId];
        }

        if (fullRebuild) {
            if (isCurrentlyBuilding) {
                this.InterruptBuild();
            }
            this._buildDebounce.Exec();
        } else if (rebuildEntrypoint) {
            this._remainingBuildItems.add(itemId);
            this.TryRebuildEntrypoint(itemId);
        }
    }

    public Dispose() {
        this.InterruptBuild();
        this._buildDebounce.Terminate();
        this.Events.removeAllListeners();
        (Object.keys(this._buildStatus) as ItemIds[]).forEach(itemId => this.RemoveEntrypoint(itemId));
    }
}