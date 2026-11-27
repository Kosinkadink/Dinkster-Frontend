import { createContext, mergeProps, useContext, type JSX } from 'solid-js'

export const defaultProductStrings = {
  mainNavigation: 'Main navigation',
  toggleNavigation: 'Toggle navigation',
  accountMenu: 'Account menu',
  signedIn: 'Signed in',
  qaServices: 'QA services',
  customServices: 'Custom services',
  customServiceShort: 'Custom',
  developmentProject: 'Development project - unpublished sources',
  development: 'Development',
  developmentShort: 'Dev',
  signIn: 'Sign in',
  signingIn: 'Signing in',
  openSignInPage: 'Open the sign-in page',
  cancelSignIn: 'Cancel sign-in',
  signOut: 'Sign out',
  projects: 'Projects',
  allProjects: 'All projects',
  newProject: 'New project',
  openInNewWindow: 'Open in a new window',
  projectsUnavailable: 'Projects could not be loaded',
  noMenuMatches: 'No matches',
  dismissError: 'Dismiss error',
  dismissNotification: 'Dismiss notification',
  close: 'Close',
  cancel: 'Cancel',
  save: 'Save',
  undoChanges: 'Undo changes',
  saveFailed: 'Changes could not be saved. Try again.',
  setSecretTitle: 'Set {name}',
  secretScope: 'Scope',
  secretAccountScope: 'Your account',
  secretDeploymentScope: 'Deployment',
  secretValue: 'Secret value',
  secretSave: 'Save secret',
  secretSaving: 'Saving...',
  secretSaveFailed: 'Could not save this secret.',
  removeSecretTitle: 'Remove your value for "{name}"?',
  secretRemove: 'Remove secret',
  secretRemoveConfirm: 'Remove',
  secretRemoveFallback: 'Runs will use the deployment value instead.',
  secretRemoveMissing: 'Nodes that require this secret will not run until it is set again.',
  secretRemoveFailed: 'Could not remove this secret.',
  byteSizeInvalid: 'Enter a size in B, KB, MB, GB or TB.',
  byteSizeMinimum: 'Enter a size of at least {size}.',
  loading: 'Loading',
  tryAgain: 'Try again',
  version: 'Version',
  copy: 'Copy',
  copyFailed: 'Could not copy. Select and copy the value instead.',
  statusSeparator: ', ',
  modelNotDownloaded: 'Not downloaded',
  modelDownloading: 'Downloading',
  modelChecking: 'Checking',
  modelDownloadFailed: 'Download failed',
  modelUnavailable: 'Unavailable',
  modelDownload: 'Download',
  modelShowFolder: 'Show folder',
  modelCopyName: 'Copy name',
  modelHide: 'Hide in this project',
  modelVersions: '{count} versions',
  modelHere: '{count} here',
  modelToDownload: '{count} to download',
}

export type ProductStrings = Readonly<
  Record<keyof typeof defaultProductStrings, string>
>

const ProductStringsContext = createContext<ProductStrings>(
  defaultProductStrings,
)

/** Replaces the text the components supply themselves, such as for another
 * language. Omitted entries keep their English default. */
export function ProductStringsProvider(props: {
  strings: Partial<ProductStrings>
  children: JSX.Element
}) {
  const strings = mergeProps(defaultProductStrings, () => props.strings)
  return (
    <ProductStringsContext.Provider value={strings}>
      {props.children}
    </ProductStringsContext.Provider>
  )
}

export const useProductStrings = (): ProductStrings =>
  useContext(ProductStringsContext)
