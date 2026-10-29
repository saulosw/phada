import type { CiBlock, ConversationBlock } from '../app/read-run-report.js'
import type { RelatedReport } from '../app/related-report.js'
import type { ContextReport } from '../context/types.js'
import type { ImpactReport } from '../graph/report.js'
import type { InvestigationReport } from '../investigation/tools/report.js'
import type { UsageReport } from '../review/token-usage.js'
import type { PassReport } from '../review/types.js'
import { formatCiSection } from './format-ci.js'
import { formatClaimsSection } from './format-claims.js'
import type { ClaimLine } from './format-claims.js'
import { formatCloseToCutSection } from './format-close-to-cut.js'
import type { CutFinding } from './format-close-to-cut.js'
import { formatContextSection } from './format-context.js'
import { formatConversationSection } from './format-conversation.js'
import { formatImpactSection } from './format-impact.js'
import { formatInvestigationSection } from './format-investigation.js'
import { formatPassesSection } from './format-passes.js'
import type { BlockedFix } from './format-passes.js'
import { formatRelatedSection } from './format-related.js'
import { formatUsageSection } from './format-usage.js'

export interface RunSections {
  closeToCut?: { findings: readonly CutFinding[]; minConfidence: number }
  claims?: readonly ClaimLine[]
  context?: ContextReport
  conversation?: ConversationBlock | null
  ci?: CiBlock | null
  impact?: { report: ImpactReport; text?: string }
  related?: RelatedReport
  passes?: { reports: readonly PassReport[]; fixFor?: BlockedFix }
  investigation?: InvestigationReport
  usage?: UsageReport
}

export function formatRunSections(sections: RunSections): string[] {
  const { closeToCut, claims, context, conversation, ci, impact, related, passes } = sections
  const { investigation, usage } = sections
  return [
    closeToCut && formatCloseToCutSection(closeToCut.findings, closeToCut.minConfidence),
    claims && formatClaimsSection(claims),
    context && formatContextSection(context),
    conversation !== undefined && formatConversationSection(conversation),
    ci !== undefined && formatCiSection(ci),
    impact && formatImpactSection(impact.report, impact.text),
    related !== undefined && related.status !== 'none' && formatRelatedSection(related),
    passes && formatPassesSection(passes.reports, passes.fixFor),
    investigation && formatInvestigationSection(investigation),
    usage && formatUsageSection(usage),
  ].filter((section): section is string => typeof section === 'string')
}
