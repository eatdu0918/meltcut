"use client";

import { ArrowRightIcon } from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { useLocalStorage } from "@/services/storage/use-local-storage";
import { Button } from "../ui/button";
import { Dialog, DialogBody, DialogContent, DialogTitle } from "../ui/dialog";

export function Onboarding() {
	const [step, setStep] = useState(0);
	const [hasSeenOnboarding, setHasSeenOnboarding] = useLocalStorage({
		key: "hasSeenOnboarding",
		defaultValue: false,
	});

	const isOpen = !hasSeenOnboarding;

	const handleNext = () => {
		setStep(step + 1);
	};

	const handleClose = () => {
		setHasSeenOnboarding({ value: true });
	};

	const getStepTitle = () => {
		switch (step) {
			case 0:
				return "Welcome to MeltCut";
			case 1:
				return "Two previews, one timeline";
			default:
				return "MeltCut";
		}
	};

	const renderStepContent = () => {
		switch (step) {
			case 0:
				return (
					<div className="space-y-5">
						<div className="space-y-3">
							<Title title={getStepTitle()} />
							<Description description="MeltCut pairs the OpenCut editor with the MLT engine, the renderer behind Shotcut and Kdenlive." />
							<Description description="Your projects and media stay on this computer." />
						</div>
						<NextButton onClick={handleNext}>Next</NextButton>
					</div>
				);
			case 1:
				return (
					<div className="space-y-5">
						<div className="space-y-3">
							<Title title={getStepTitle()} />
							<Description description="The preview plays in real time. Turn on **MLT** in its toolbar to see a frame exactly as it will be exported, including MLT effects and transitions." />
							<Description description="Export uses the MLT engine by default and offers more formats than the built-in exporter." />
						</div>
						<NextButton onClick={handleClose}>Start editing</NextButton>
					</div>
				);
			default:
				return null;
		}
	};

	return (
		<Dialog open={isOpen} onOpenChange={handleClose}>
			<DialogContent className="sm:max-w-[425px]">
				<DialogTitle>
					<span className="sr-only">{getStepTitle()}</span>
				</DialogTitle>
				<DialogBody>{renderStepContent()}</DialogBody>
			</DialogContent>
		</Dialog>
	);
}

function Title({ title }: { title: string }) {
	return <h2 className="text-lg font-bold md:text-xl">{title}</h2>;
}

function Description({ description }: { description: string }) {
	return (
		<div className="text-muted-foreground">
			<ReactMarkdown
				components={{
					p: ({ children }) => <p className="mb-0">{children}</p>,
					a: ({ href, children }) => (
						<a
							href={href}
							target="_blank"
							rel="noopener noreferrer"
							className="text-foreground hover:text-foreground/80 underline"
						>
							{children}
						</a>
					),
				}}
			>
				{description}
			</ReactMarkdown>
		</div>
	);
}

function NextButton({
	children,
	onClick,
}: {
	children: React.ReactNode;
	onClick: () => void;
}) {
	return (
		<Button onClick={onClick} variant="default" className="w-full">
			{children}
			<ArrowRightIcon className="size-4" />
		</Button>
	);
}
