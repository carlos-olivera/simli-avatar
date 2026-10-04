export default function VideoBox(props: any) {
    return (
        <div className="flex items-center justify-center bg-black w-[min(90vw,70vh,720px)] aspect-square overflow-hidden">
            <video ref={props.video} autoPlay playsInline className="w-full h-full object-contain bg-black"></video>
            <audio ref={props.audio} autoPlay></audio>
        </div>
    );
}
