import {
  BookOpen,
  Brain,
  Braces,
  BriefcaseBusiness,
  ChartNoAxesColumnIncreasing,
  CircleDollarSign,
  CookingPot,
  Dumbbell,
  FlaskConical,
  Flower2,
  FolderKanban,
  Gamepad2,
  Globe2,
  GraduationCap,
  Heart,
  MessageCircle,
  Music2,
  NotebookTabs,
  Palette,
  PawPrint,
  PenTool,
  Pencil,
  Plane,
  Popcorn,
  Satellite,
  Scale,
  Sprout,
  SquareTerminal,
  Stethoscope,
  Wrench
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ProjectIconColor, ProjectIconName, ProjectKind } from '@shared/types'
import { defaultProjectIcon } from '@shared/projectAppearance'

const projectIcons: Record<ProjectIconName, LucideIcon> = {
  folder: FolderKanban,
  'message-circle': MessageCircle,
  'circle-dollar-sign': CircleDollarSign,
  'book-open': BookOpen,
  'graduation-cap': GraduationCap,
  pencil: Pencil,
  'pen-tool': PenTool,
  braces: Braces,
  'square-terminal': SquareTerminal,
  music: Music2,
  popcorn: Popcorn,
  satellite: Satellite,
  palette: Palette,
  stethoscope: Stethoscope,
  flower: Flower2,
  briefcase: BriefcaseBusiness,
  chart: ChartNoAxesColumnIncreasing,
  'cooking-pot': CookingPot,
  dumbbell: Dumbbell,
  notebook: NotebookTabs,
  scale: Scale,
  globe: Globe2,
  plane: Plane,
  wrench: Wrench,
  'paw-print': PawPrint,
  flask: FlaskConical,
  brain: Brain,
  heart: Heart,
  sprout: Sprout,
  gamepad: Gamepad2
}

interface ProjectIconProps {
  className?: string
  color?: ProjectIconColor
  icon?: ProjectIconName
  kind: ProjectKind
  size: number
}

export function ProjectIcon({ className, color, icon, kind, size }: ProjectIconProps) {
  const Icon = projectIcons[icon ?? defaultProjectIcon(kind)]

  return (
    <Icon
      className={className}
      data-project-icon-color={color}
      size={size}
      style={color ? { color: `var(--project-icon-${color})` } : undefined}
    />
  )
}
