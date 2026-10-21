/**
 * Registers the onboarding and report previews with the gallery. Called explicitly by <ArtGallery/>
 * (the package is side-effect free, so registration must not rely on import side effects).
 */
import { registerOnboardingGalleryRoutes } from '../../onboarding/gallery.ts';
import { registerReportGalleryRoutes } from '../../report/gallery.ts';
import { registerCharacterRigGalleryRoutes } from '../characters/gallery.ts';

export function registerAllGalleryRoutes(): void {
  registerCharacterRigGalleryRoutes();
  registerOnboardingGalleryRoutes();
  registerReportGalleryRoutes();
}
