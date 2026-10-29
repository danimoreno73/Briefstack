import type { DriftItem, EnvWarning, ResearchMode } from '../usage/index.js';
import { defineCatalogue } from './index.js';

const value = (text: string | undefined): string => text ?? '(none)';
const valor = (text: string | undefined): string => text ?? '(ninguno)';

export const usageMessages = defineCatalogue({
  en: {
    usage: 'briefstack usage <show [--json] | set <profile> [--project <dir>]>',
    activeProfile: (name: string, label: string) => `Active profile: ${name} (${label})`,
    defaultProfileNote: 'No profile chosen yet; this is the default.',
    sessionModel: (model: string) =>
      `Main session model this profile expects: ${model}. briefstack cannot change it in an interactive session. For this session only, open /model and press s on ${model}, or start with claude --model ${model}; typing /model ${model} also makes it your default for new sessions.`,
    chatModel: (model: string, effort: string) => `Web app chat: ${model}, effort ${effort}.`,
    workModel: (model: string, effort: string) => `Tasks in existing projects: ${model}, effort ${effort}.`,
    agentsHeader: 'Agents:',
    agentLine: (agent: string, model: string, effort: string) => `  ${agent.padEnd(12)} ${model.padEnd(8)} effort ${effort}`,
    projectTiers: (light: string, standard: string, heavy: string) =>
      `Generated project agents: light ${light}, standard ${standard}, heavy ${heavy}`,
    research: (mode: ResearchMode) =>
      mode === 'required-only'
        ? 'Research: only when the spec cannot be written without it'
        : 'Research: when useful',
    reviewRounds: (rounds: number) => `Review rounds: at most ${rounds}`,
    available: (names: readonly string[]) => `Available profiles: ${names.join(', ')}`,
    driftHeader: 'Warning: agent files differ from the committed version (do not commit profile changes):',
    driftLine: (item: DriftItem) =>
      `  ${item.file}: ${item.field} ${value(item.committed)} -> ${value(item.current)}`,
    envWarning: (warning: EnvWarning) =>
      warning.field === 'model'
        ? `Warning: ${warning.variable}=${warning.value} is set, so Claude Code ignores the model in the agent files.`
        : `Warning: ${warning.variable}=${warning.value} is set, so it overrides the effort in the agent files.`,
    consumption: 'Levels are qualitative. For real consumption, run /usage in Claude Code.',
    applied: (name: string) => `Applied profile "${name}".`,
    changedFiles: (files: readonly string[]) => `Changed: ${files.join(', ')}`,
    noChanges: 'No agent file needed changes.',
    notInProfile: (files: readonly string[]) => `Left alone (not in the profile): ${files.join(', ')}`,
    missingAgents: (agents: readonly string[]) =>
      `Listed in .briefstack/profile.json but without an agent file: ${agents.join(', ')}`,
    savedActive: (name: string) => `Saved "${name}" as the active profile.`,
    doNotCommit: 'Do not commit these agent file changes; the repo keeps them on the default profile.',
    projectApplied: (dir: string, name: string, previous: string) =>
      previous === name
        ? `Project ${dir} is on profile "${name}".`
        : `Project ${dir} moved from profile "${previous}" to "${name}".`,
  },
  es: {
    usage: 'briefstack usage <show [--json] | set <perfil> [--project <carpeta>]>',
    activeProfile: (name: string, label: string) => `Perfil activo: ${name} (${label})`,
    defaultProfileNote: 'Aún no se ha elegido perfil; este es el predeterminado.',
    sessionModel: (model: string) =>
      `Modelo de la sesión principal que espera este perfil: ${model}. briefstack no puede cambiarlo en una sesión interactiva. Solo para esta sesión, abre /model y pulsa s sobre ${model}, o arranca con claude --model ${model}; escribir /model ${model} también lo deja como predeterminado para sesiones nuevas.`,
    chatModel: (model: string, effort: string) => `Chat de la app web: ${model}, esfuerzo ${effort}.`,
    workModel: (model: string, effort: string) => `Tareas en proyectos existentes: ${model}, esfuerzo ${effort}.`,
    agentsHeader: 'Agentes:',
    agentLine: (agent: string, model: string, effort: string) =>
      `  ${agent.padEnd(12)} ${model.padEnd(8)} esfuerzo ${effort}`,
    projectTiers: (light: string, standard: string, heavy: string) =>
      `Agentes de los proyectos generados: light ${light}, standard ${standard}, heavy ${heavy}`,
    research: (mode: ResearchMode) =>
      mode === 'required-only'
        ? 'Investigación: solo si la spec no puede escribirse sin ella'
        : 'Investigación: cuando sea útil',
    reviewRounds: (rounds: number) => `Rondas de revisión: como máximo ${rounds}`,
    available: (names: readonly string[]) => `Perfiles disponibles: ${names.join(', ')}`,
    driftHeader:
      'Aviso: los archivos de agentes difieren de la versión confirmada en git (no hagas commit de los cambios de perfil):',
    driftLine: (item: DriftItem) =>
      `  ${item.file}: ${item.field} ${valor(item.committed)} -> ${valor(item.current)}`,
    envWarning: (warning: EnvWarning) =>
      warning.field === 'model'
        ? `Aviso: ${warning.variable}=${warning.value} está definida, así que Claude Code ignora el modelo de los archivos de agentes.`
        : `Aviso: ${warning.variable}=${warning.value} está definida, así que sustituye el esfuerzo de los archivos de agentes.`,
    consumption: 'Los niveles son cualitativos. Para ver el consumo real, ejecuta /usage en Claude Code.',
    applied: (name: string) => `Perfil "${name}" aplicado.`,
    changedFiles: (files: readonly string[]) => `Modificados: ${files.join(', ')}`,
    noChanges: 'Ningún archivo de agente necesitaba cambios.',
    notInProfile: (files: readonly string[]) => `Sin tocar (no están en el perfil): ${files.join(', ')}`,
    missingAgents: (agents: readonly string[]) =>
      `En .briefstack/profile.json pero sin archivo de agente: ${agents.join(', ')}`,
    savedActive: (name: string) => `"${name}" guardado como perfil activo.`,
    doNotCommit:
      'No hagas commit de estos cambios en los archivos de agentes; el repo los mantiene en el perfil predeterminado.',
    projectApplied: (dir: string, name: string, previous: string) =>
      previous === name
        ? `El proyecto ${dir} está en el perfil "${name}".`
        : `El proyecto ${dir} pasa del perfil "${previous}" a "${name}".`,
  },
});
