import type { CustomToolDefinition } from '../shared/customTools'
import type { ToolPackage, ResolvedToolSelection } from '../shared/toolPackages'
export const selectedTools = (entries: string[] = []): ResolvedToolSelection => ({ project: false, entries })
export function toolPackageFixture(definition: CustomToolDefinition): ToolPackage {
  return { id: definition.id, name: definition.name, description: definition.description,
    rootId: 'user', rootName: 'User', source: 'user', directory: '/fixture/tools/' + definition.id,
    definition }
}
