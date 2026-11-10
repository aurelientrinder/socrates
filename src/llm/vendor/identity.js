/** Merge identities field by field; later sources win and undefined fields are skipped. */
export function mergeClientIdentity(...sources) {
    let merged;
    for (const source of sources) {
        if (!source)
            continue;
        merged = { ...merged };
        if (source.userAgent !== undefined)
            merged.userAgent = source.userAgent;
        if (source.attribution !== undefined)
            merged.attribution = source.attribution;
        if (source.version !== undefined)
            merged.version = source.version;
    }
    return merged;
}
