import { useRef, useState, type DragEvent } from "react";

interface Props {
  onFiles: (files: File[]) => void;
  multiple?: boolean;
  label?: string;
  hint?: string;
}

/** File picker that also accepts drops. */
export function Dropzone({ onFiles, multiple = false, label, hint }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const accept = (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (files.length > 0) onFiles(multiple ? files : [files[0]!]);
  };

  const stop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <>
      <div
        className={`dropzone${over ? " over" : ""}`}
        onClick={() => input.current?.click()}
        onDragEnter={(e) => {
          stop(e);
          setOver(true);
        }}
        onDragOver={stop}
        onDragLeave={(e) => {
          stop(e);
          setOver(false);
        }}
        onDrop={(e) => {
          stop(e);
          setOver(false);
          accept(e.dataTransfer.files);
        }}
      >
        <strong>{label ?? "Choose a video"}</strong>
        <span>{hint ?? "or drop it here — MP4 / MOV. It never leaves your machine."}</span>
      </div>
      <input
        ref={input}
        type="file"
        accept="video/mp4,video/quicktime,video/*"
        multiple={multiple}
        style={{ display: "none" }}
        onChange={(e) => accept(e.target.files)}
      />
    </>
  );
}
