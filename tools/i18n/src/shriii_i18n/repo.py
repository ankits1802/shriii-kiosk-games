"""Repository layout, loading and deterministic saving of the YAML sources."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from .models import Catalogue, RegisterGuide, TranslationFile, Workflow

CATALOGUE_REL = Path("content/i18n/lines.yaml")
TRANSLATIONS_REL = Path("content/i18n/translations")
WORKFLOW_FILE = "workflow.yaml"
REGISTER_GUIDE_FILE = "register-guide.yaml"


class RepoError(RuntimeError):
    """Raised when the repository layout or a source file is unusable."""


def find_repo_root(start: Path | None = None) -> Path:
    """Walk up from ``start`` (default: cwd) to the directory that contains ``content/i18n/lines.yaml``."""
    here = (start or Path.cwd()).resolve()
    for candidate in [here, *here.parents]:
        if (candidate / CATALOGUE_REL).is_file():
            return candidate
    raise RepoError(f"could not find {CATALOGUE_REL} above {here}")


def _load_yaml(path: Path) -> Any:
    try:
        with path.open(encoding="utf-8") as fh:
            return yaml.safe_load(fh)
    except FileNotFoundError as exc:
        raise RepoError(f"missing file: {path}") from exc
    except yaml.YAMLError as exc:
        raise RepoError(f"invalid YAML in {path}: {exc}") from exc


class _Dumper(yaml.SafeDumper):
    """SafeDumper that indents block sequences under their parent key (matches the repo's YAML style)."""

    def increase_indent(self, flow: bool = False, indentless: bool = False) -> None:
        super().increase_indent(flow, False)


def dump_yaml(data: Any) -> str:
    return yaml.dump(data, Dumper=_Dumper, allow_unicode=True, sort_keys=False, width=100_000, indent=2)


@dataclass(frozen=True)
class Repo:
    root: Path

    @classmethod
    def discover(cls, root: Path | None = None) -> Repo:
        return cls(root.resolve() if root else find_repo_root())

    @property
    def catalogue_path(self) -> Path:
        return self.root / CATALOGUE_REL

    @property
    def translations_dir(self) -> Path:
        return self.root / TRANSLATIONS_REL

    @property
    def workflow_path(self) -> Path:
        return self.translations_dir / WORKFLOW_FILE

    def load_catalogue(self) -> Catalogue:
        return Catalogue.model_validate(_load_yaml(self.catalogue_path))

    def load_workflow(self) -> Workflow:
        return Workflow.model_validate(_load_yaml(self.workflow_path))

    @property
    def register_guide_path(self) -> Path:
        return self.translations_dir / REGISTER_GUIDE_FILE

    def load_register_guide(self) -> RegisterGuide | None:
        """The register guide is optional; without it the glossary check is skipped."""
        if not self.register_guide_path.is_file():
            return None
        return RegisterGuide.model_validate(_load_yaml(self.register_guide_path))

    def translation_path(self, workflow: Workflow, language: str) -> Path:
        return self.translations_dir / workflow.language(language).translation_file

    def load_translations(self, workflow: Workflow, language: str) -> TranslationFile:
        path = self.translation_path(workflow, language)
        data = TranslationFile.model_validate(_load_yaml(path))
        if data.language != language:
            raise RepoError(f"{path} declares language {data.language!r}, expected {language!r}")
        return data

    def save_translations(self, workflow: Workflow, data: TranslationFile) -> Path:
        path = self.translation_path(workflow, data.language)
        write_translation_file(path, data)
        return path


_HEADER = (
    "# Recording-script translations for {lang} (VOX-07). Generated and validated by tools/i18n\n"
    "# (`shriii-i18n validate`). Edit through the XLSX round-trip (`shriii-i18n export` / `import`) so that\n"
    "# every status change carries a reviewer sign-off; hand edits must keep the history chain valid.\n"
    "# Status meanings and allowed transitions: content/i18n/translations/workflow.yaml.\n"
)


def write_translation_file(path: Path, data: TranslationFile) -> None:
    payload = data.model_dump(mode="json")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_HEADER.format(lang=data.language) + dump_yaml(payload), encoding="utf-8", newline="\n")
