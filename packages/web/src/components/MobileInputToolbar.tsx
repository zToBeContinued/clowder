import { AttachIcon } from './icons/AttachIcon';

interface MobileInputToolbarProps {
  onAttach: () => void;
  onClose: () => void;
  disabled?: boolean;
  sendDisabled?: boolean;
  maxImages?: boolean;
}

/**
 * Expandable toolbar for mobile input — compact attachment access.
 * Shown above the main input row when user taps the + button.
 */
export function MobileInputToolbar({ onAttach, onClose, disabled, sendDisabled, maxImages }: MobileInputToolbarProps) {
  const btnBase =
    'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border transition-colors disabled:opacity-30';

  return (
    <div className="flex gap-2 px-4 pt-2 md:hidden">
      <button
        onClick={() => {
          onAttach();
          onClose();
        }}
        disabled={disabled || sendDisabled || maxImages}
        className={`${btnBase} text-cafe-secondary bg-cafe-surface border-[var(--console-border-soft)] hover:border-cafe-accent hover:text-cafe-accent`}
      >
        <AttachIcon className="w-4 h-4" /> 附件
      </button>
    </div>
  );
}
