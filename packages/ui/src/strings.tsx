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
  dismissError: 'Dismiss error',
  dismissNotification: 'Dismiss notification',
  close: 'Close',
  cancel: 'Cancel',
  save: 'Save',
  undoChanges: 'Undo changes',
  saveFailed: 'Changes could not be saved. Try again.',
  loading: 'Loading',
  version: 'Version',
  copy: 'Copy',
  copyFailed: 'Could not copy. Select and copy the value instead.',
  statusSeparator: ', ',
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
