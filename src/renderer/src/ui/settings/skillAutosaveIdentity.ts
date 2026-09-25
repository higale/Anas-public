export class SkillAutosaveIdentity {
  private sequence = 0
  private activeEntityId = 'skill:none:0'
  private persistedName?: string

  begin(persistedName?: string): string {
    this.activeEntityId = `skill:editor:${++this.sequence}`
    this.persistedName = persistedName
    return this.activeEntityId
  }

  clear(): string {
    this.activeEntityId = `skill:none:${++this.sequence}`
    this.persistedName = undefined
    return this.activeEntityId
  }

  currentEntityId(): string {
    return this.activeEntityId
  }

  originalName(entityId: string): string | undefined {
    return entityId === this.activeEntityId ? this.persistedName : undefined
  }

  markSaved(entityId: string, name: string): void {
    if (entityId === this.activeEntityId) this.persistedName = name
  }

  isActive(entityId: string): boolean {
    return entityId === this.activeEntityId
  }
}
