import type { PackPreparationProgress } from '@dinkster/client'
import { useAppMessage } from './locale.js'

export function PackPreparationStatus(props: { readonly progress: PackPreparationProgress | undefined }) {
  const message = useAppMessage()
  const stage = () => {
    switch (props.progress?.stage) {
      case 'checking-software': case 'checking-unexpected-files': return message('packPreparation.software')
      case 'checking-registry-metadata': return message('packPreparation.registry')
      case 'preparing-runtime': return message('packPreparation.runtime')
      case 'checking-pack-requirements': return message('packPreparation.requirements')
      case 'preparing-pack-sources': case 'acquiring-pack-inputs': return message('packPreparation.inputs')
      case 'checking-pack-admission': return message('packPreparation.admission')
      case 'retaining-review': return message('packPreparation.review')
      default: return message('packPreparation.queued')
    }
  }
  return <span>{stage()}{props.progress?.total ? ` (${props.progress.completed}/${props.progress.total})` : ''}</span>
}
